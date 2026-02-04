// server.js - Backend server with Google OAuth AND Calendar Subscriptions
const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// In-memory storage for subscription feeds (replace with database in production)
const subscriptionFeeds = new Map();

// Google OAuth Configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
);

// Scopes define what access you need
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

// ============================================
// ICS/RFC 5545 HELPER FUNCTIONS
// ============================================

const formatDateForICS = (date) => {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
};

const escapeICSText = (text) => {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
};

const generateCalendarFeed = (calendar) => {
  const events = calendar.events || [];
  
  let icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Calendar App//WhatsApp Calendar//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:${escapeICSText(calendar.name)}`;

  if (calendar.description) {
    icsContent += `\nX-WR-CALDESC:${escapeICSText(calendar.description)}`;
  }

  icsContent += `
X-WR-TIMEZONE:UTC
REFRESH-INTERVAL;VALUE=DURATION:PT1H
X-PUBLISHED-TTL:PT1H
`;

  // Add each event
  events.forEach(event => {
    const startDate = new Date(event.date + 'T' + (event.time || '12:00'));
    const endDate = event.endTime 
      ? new Date(event.date + 'T' + event.endTime)
      : new Date(startDate.getTime() + 60 * 60 * 1000);

    const now = new Date();
    const uid = event.id + '@calendar-app.com';

    icsContent += `BEGIN:VEVENT
UID:${uid}
DTSTAMP:${formatDateForICS(now)}
DTSTART:${formatDateForICS(startDate)}
DTEND:${formatDateForICS(endDate)}
SUMMARY:${escapeICSText(event.title)}`;

    if (event.description) {
      icsContent += `\nDESCRIPTION:${escapeICSText(event.description)}`;
    }

    if (event.location) {
      icsContent += `\nLOCATION:${escapeICSText(event.location)}`;
    }

    icsContent += `
STATUS:CONFIRMED
SEQUENCE:0
END:VEVENT
`;
  });

  icsContent += `END:VCALENDAR`;
  return icsContent;
};

// ============================================
// GOOGLE OAUTH ROUTES
// ============================================

// ROUTE 1: Initiate OAuth flow
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Gets refresh token
    scope: SCOPES,
    prompt: 'consent' // Force consent screen to get refresh token
  });
  
  res.redirect(authUrl);
});

// ROUTE 2: Handle OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).send('No authorization code received');
  }
  
  try {
    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store tokens in session (in production, store in database)
    req.session.tokens = tokens;
    
    // Set credentials for this session
    oauth2Client.setCredentials(tokens);
    
    // Redirect to frontend success page

    // res.redirect('http://localhost:3001/calendar?auth=success');

    res.redirect('https://whatsapp-calendar-frontend-omega.vercel.app/calendar?auth=success');

  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).send('Authentication failed');
  }
});

// ============================================
// GOOGLE CALENDAR API ROUTES
// ============================================

// ROUTE 3: Get user's calendars
app.get('/api/calendars', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const response = await calendar.calendarList.list();
    res.json(response.data.items);
  } catch (error) {
    console.error('Error fetching calendars:', error);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

// ROUTE 4: Create a new calendar (Google Calendar + Subscription Feed)
app.post('/api/calendars', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { name, description } = req.body;
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Create Google Calendar
    const newCalendar = await calendar.calendars.insert({
      requestBody: {
        summary: name,
        description: description,
        timeZone: 'UTC'
      }
    });
    
    const calendarId = newCalendar.data.id;
    
    // Store in subscription feeds map
    subscriptionFeeds.set(calendarId, {
      id: calendarId,
      name: name,
      description: description,
      events: [],
      googleCalendarId: calendarId
    });
    
    // Return calendar with subscription URLs
    res.json({
      ...newCalendar.data,
      subscriptionUrl: `${req.protocol}://${req.get('host')}/api/subscriptions/${calendarId}/feed.ics`,
      webcalUrl: `webcal://${req.get('host')}/api/subscriptions/${calendarId}/feed.ics`
    });
  } catch (error) {
    console.error('Error creating calendar:', error);
    res.status(500).json({ error: 'Failed to create calendar' });
  }
});

// ROUTE 5: Get events from a calendar
app.get('/api/calendars/:calendarId/events', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { calendarId } = req.params;
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: new Date().toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    res.json(response.data.items);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// ROUTE 6: Create an event (Google Calendar + Update Subscription Feed)
app.post('/api/calendars/:calendarId/events', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { calendarId } = req.params;
  const { title, description, startDateTime, endDateTime, location, date, time, endTime } = req.body;
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Handle both date formats (ISO string or date+time)
    let start, end;
    if (startDateTime && endDateTime) {
      start = { dateTime: startDateTime, timeZone: 'UTC' };
      end = { dateTime: endDateTime, timeZone: 'UTC' };
    } else if (date) {
      const startDate = new Date(date + 'T' + (time || '12:00'));
      const endDate = endTime 
        ? new Date(date + 'T' + endTime)
        : new Date(startDate.getTime() + 60 * 60 * 1000);
      start = { dateTime: startDate.toISOString(), timeZone: 'UTC' };
      end = { dateTime: endDate.toISOString(), timeZone: 'UTC' };
    }
    
    const event = {
      summary: title,
      description: description,
      location: location,
      start: start,
      end: end
    };
    
    const response = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: event
    });
    
    // Update subscription feed
    const feed = subscriptionFeeds.get(calendarId);
    if (feed) {
      feed.events.push({
        id: response.data.id,
        title: title,
        description: description,
        location: location,
        date: date,
        time: time,
        endTime: endTime,
        googleEventId: response.data.id
      });
      subscriptionFeeds.set(calendarId, feed);
    }
    
    res.json({
      ...response.data,
      message: 'Event added to Google Calendar and subscription feed'
    });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// ROUTE 7: Delete an event (Google Calendar + Update Subscription Feed)
app.delete('/api/calendars/:calendarId/events/:eventId', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { calendarId, eventId } = req.params;
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId
    });
    
    // Update subscription feed
    const feed = subscriptionFeeds.get(calendarId);
    if (feed) {
      feed.events = feed.events.filter(e => e.id != eventId && e.googleEventId != eventId);
      subscriptionFeeds.set(calendarId, feed);
    }
    
    res.json({ 
      success: true,
      message: 'Event deleted from Google Calendar and subscription feed'
    });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ROUTE 8: Share calendar with someone
app.post('/api/calendars/:calendarId/share', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { calendarId } = req.params;
  const { email, role } = req.body; // role: 'reader', 'writer', 'owner'
  
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const acl = await calendar.acl.insert({
      calendarId: calendarId,
      requestBody: {
        role: role || 'reader',
        scope: {
          type: 'user',
          value: email
        }
      }
    });
    
    res.json(acl.data);
  } catch (error) {
    console.error('Error sharing calendar:', error);
    res.status(500).json({ error: 'Failed to share calendar' });
  }
});

// ============================================
// CALENDAR SUBSCRIPTION FEED ROUTES (NEW)
// ============================================

// ROUTE 9: Get calendar subscription feed (ICS format)
app.get('/api/subscriptions/:calendarId/feed.ics', async (req, res) => {
  const { calendarId } = req.params;
  
  // Try to get from subscription feeds first
  let calendarData = subscriptionFeeds.get(calendarId);
  
  // If not in subscription feeds but authenticated, try to fetch from Google Calendar
  if (!calendarData && req.session && req.session.tokens) {
    try {
      oauth2Client.setCredentials(req.session.tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Get calendar info
      const calInfo = await calendar.calendars.get({ calendarId: calendarId });
      
      // Get events
      const eventsResponse = await calendar.events.list({
        calendarId: calendarId,
        timeMin: new Date().toISOString(),
        maxResults: 100,
        singleEvents: true,
        orderBy: 'startTime'
      });
      
      // Convert Google Calendar events to our format
      const events = eventsResponse.data.items.map(event => {
        const start = new Date(event.start.dateTime || event.start.date);
        const end = new Date(event.end.dateTime || event.end.date);
        
        return {
          id: event.id,
          title: event.summary,
          description: event.description,
          location: event.location,
          date: start.toISOString().split('T')[0],
          time: start.toISOString().split('T')[1].substring(0, 5),
          endTime: end.toISOString().split('T')[1].substring(0, 5),
          googleEventId: event.id
        };
      });
      
      calendarData = {
        id: calendarId,
        name: calInfo.data.summary,
        description: calInfo.data.description,
        events: events
      };
      
      // Cache it
      subscriptionFeeds.set(calendarId, calendarData);
    } catch (error) {
      console.error('Error fetching from Google Calendar:', error);
    }
  }
  
  if (!calendarData) {
    return res.status(404).send('Calendar not found');
  }
  
  const icsContent = generateCalendarFeed(calendarData);
  
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${calendarData.name.replace(/[^a-z0-9]/gi, '_')}.ics"`);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(icsContent);
});

// ROUTE 10: Update subscription feed manually (for non-Google calendars)
app.post('/api/subscriptions/:calendarId', (req, res) => {
  const { calendarId } = req.params;
  const calendarData = req.body;
  
  subscriptionFeeds.set(calendarId, calendarData);
  
  res.json({
    success: true,
    calendarId,
    subscriptionUrl: `${req.protocol}://${req.get('host')}/api/subscriptions/${calendarId}/feed.ics`,
    webcalUrl: `webcal://${req.get('host')}/api/subscriptions/${calendarId}/feed.ics`
  });
});

// ============================================
// AUTHENTICATION & UTILITY ROUTES
// ============================================

// ROUTE 11: Check authentication status
app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.session.tokens,
    tokens: req.session.tokens ? 'present' : 'none'
  });
});

// ROUTE 12: Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ROUTE 13: Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    subscriptionFeeds: subscriptionFeeds.size,
    googleOAuth: !!process.env.GOOGLE_CLIENT_ID
  });
});

// Handle token refresh automatically
oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    // Store refresh token in database in production
    console.log('New refresh token received');
  }
  console.log('Access token refreshed');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Initiate OAuth: http://localhost:${PORT}/auth/google`);
  console.log(`Subscription feeds: http://localhost:${PORT}/api/subscriptions/{calendarId}/feed.ics`);
});

// Export for testing
module.exports = app;
