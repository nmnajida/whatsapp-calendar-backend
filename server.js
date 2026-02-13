// server.js - Universal Calendar Backend with Token-Based Authentication
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// JWT Secret (use SESSION_SECRET or generate new one)
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'your-jwt-secret';

// Trust Railway proxy
app.set('trust proxy', 1);

// CORS Configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://whatsapp-calendar-frontend-omega.vercel.app',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Supabase Configuration
// Public client (anon key) - for regular operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client (service_role key) - for magic_links and users table
// This bypasses Row Level Security (RLS)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// MIDDLEWARE
// ============================================

// Authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.userEmail = user.email;
    next();
  });
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Generate random token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Generate JWT
function generateJWT(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '7d' });
}

// Send magic link email via Resend
async function sendMagicLinkEmail(email, token) {
  const magicLink = `${process.env.BACKEND_URL || 'http://localhost:3000'}/auth/verify/${token}`;
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
        to: email,
        subject: 'Sign in to Hot Club Calendar',
        html: `
          <h2>Sign in to Hot Club Calendar</h2>
          <p>Click the link below to sign in:</p>
          <p><a href="${magicLink}" style="background-color: #4CAF50; color: white; padding: 14px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Sign In</a></p>
          <p>Or copy this link: ${magicLink}</p>
          <p><small>This link expires in 15 minutes.</small></p>
        `
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend API error: ${error}`);
    }

    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

// Generate ICS calendar feed
function generateCalendarFeed(calendarData) {
  const events = calendarData.events || [];
  
  let icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Telematrix Calendar//EN',
    `NAME:${calendarData.name}`,
    `X-WR-CALNAME:${calendarData.name}`,
    'X-WR-TIMEZONE:UTC',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ];

  events.forEach(event => {
    const startDateTime = new Date(event.event_date + 'T' + (event.start_time || '12:00')).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endDateTime = event.end_time 
      ? new Date(event.event_date + 'T' + event.end_time).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
      : new Date(new Date(startDateTime).getTime() + 3600000).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    icsContent.push(
      'BEGIN:VEVENT',
      `UID:${event.google_event_id || event.id}@hotclub.calendar`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
      `DTSTART:${startDateTime}`,
      `DTEND:${endDateTime}`,
      `SUMMARY:${event.title}`,
      event.description ? `DESCRIPTION:${event.description}` : '',
      event.location ? `LOCATION:${event.location}` : '',
      'STATUS:CONFIRMED',
      'SEQUENCE:0',
      'END:VEVENT'
    );
  });

  icsContent.push('END:VCALENDAR');
  
  return icsContent.filter(line => line).join('\r\n');
}

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// ROUTE 1: Request magic link
app.post('/auth/request-magic-link', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    // Generate token
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store magic link in database
    const { error: linkError } = await supabaseAdmin
      .from('magic_links')
      .insert([{
        email: email.toLowerCase(),
        token: token,
        expires_at: expiresAt.toISOString()
      }]);

    if (linkError) {
      console.error('Error storing magic link:', linkError);
      return res.status(500).json({ error: 'Failed to generate magic link' });
    }

    // Create or update user
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (!existingUser) {
      await supabaseAdmin
        .from('users')
        .insert([{ email: email.toLowerCase() }]);
    }

    // Send email
    await sendMagicLinkEmail(email, token);

    res.json({ 
      success: true,
      message: 'Magic link sent! Check your email.' 
    });
  } catch (error) {
    console.error('Error in magic link request:', error);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// ROUTE 2: Verify magic link token and return JWT
app.get('/auth/verify/:token', async (req, res) => {
  const { token } = req.params;

  try {
    // Check if token exists and is valid
    const { data: magicLink, error: linkError } = await supabaseAdmin
      .from('magic_links')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (linkError || !magicLink) {
      return res.status(400).send('Invalid or expired magic link');
    }

    // Check if expired
    if (new Date(magicLink.expires_at) < new Date()) {
      return res.status(400).send('Magic link has expired');
    }

    // Mark as used
    await supabaseAdmin
      .from('magic_links')
      .update({ used: true })
      .eq('token', token);

    // Update user last login
    await supabaseAdmin
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('email', magicLink.email);

    // Generate JWT token
    const jwtToken = generateJWT(magicLink.email);

    // Redirect to frontend with JWT token
    const frontendUrl = process.env.FRONTEND_URL || 'https://whatsapp-calendar-frontend-omega.vercel.app';
    res.redirect(`${frontendUrl}/?token=${jwtToken}`);
  } catch (error) {
    console.error('Error verifying magic link:', error);
    res.status(500).send('Authentication failed');
  }
});

// ROUTE 3: Check authentication status (with token)
app.get('/api/auth/status', authenticateToken, (req, res) => {
  res.json({ 
    authenticated: true,
    email: req.userEmail 
  });
});

// ROUTE 4: Logout (just for compatibility - frontend clears token)
app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});

// ============================================
// CALENDAR ROUTES (Protected with JWT)
// ============================================

// ROUTE 5: Create a new calendar
app.post('/api/calendars', authenticateToken, async (req, res) => {
  const { name, description } = req.body;

  try {
    // Create calendar in Supabase
    const { data: calendar, error: calError } = await supabase
      .from('calendars')
      .insert([{
        google_calendar_id: generateToken().substring(0, 16),
        name: name,
        description: description,
        owner_email: req.userEmail
      }])
      .select()
      .single();

    if (calError) {
      console.error('Error creating calendar:', calError);
      return res.status(500).json({ error: 'Failed to create calendar' });
    }

    // Generate subscription URLs
    const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    const subscriptionUrl = `${backendUrl}/api/subscriptions/${calendar.google_calendar_id}/feed.ics`;
    const webcalUrl = subscriptionUrl.replace('https://', 'webcal://').replace('http://', 'webcal://');

    res.json({
      id: calendar.google_calendar_id,
      summary: calendar.name,
      description: calendar.description,
      subscriptionUrl: subscriptionUrl,
      webcalUrl: webcalUrl
    });
  } catch (error) {
    console.error('Error creating calendar:', error);
    res.status(500).json({ error: 'Failed to create calendar' });
  }
});

// ROUTE 6: Get user's calendars
app.get('/api/calendars', authenticateToken, async (req, res) => {
  try {
    const { data: calendars, error } = await supabase
      .from('calendars')
      .select('*')
      .eq('owner_email', req.userEmail);

    if (error) {
      console.error('Error fetching calendars:', error);
      return res.status(500).json({ error: 'Failed to fetch calendars' });
    }

    res.json(calendars);
      } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Failed to fetch calendars' });
      }
    });

    // Delete calendar and all its events
    app.delete('/api/calendars/:calendarId', authenticateToken, async (req, res) => {
    const { calendarId } = req.params;
  
  try {
    // Verify calendar ownership
    const { data: calendar, error: fetchError } = await supabase
      .from('calendars')
      .select('*')
      .eq('google_calendar_id', calendarId)
      .eq('owner_email', req.userEmail)
      .single();

    if (fetchError || !calendar) {
      return res.status(404).json({ error: 'Calendar not found or unauthorized' });
    }

    // Delete all events for this calendar first
    const { error: eventsError } = await supabase
      .from('events')
      .delete()
      .eq('calendar_id', calendar.id);

    if (eventsError) {
      console.error('Error deleting events:', eventsError);
      return res.status(500).json({ error: 'Failed to delete calendar events' });
    }

    // Delete the calendar
    const { error: calendarError } = await supabase
      .from('calendars')
      .delete()
      .eq('id', calendar.id);

    if (calendarError) {
      console.error('Error deleting calendar:', calendarError);
      return res.status(500).json({ error: 'Failed to delete calendar' });
    }

    res.json({ success: true, message: 'Calendar deleted successfully' });
  } catch (error) {
    console.error('Error deleting calendar:', error);
    res.status(500).json({ error: 'Failed to delete calendar' });
  }
  });

// ROUTE 7: Create event
app.post('/api/calendars/:calendarId/events', authenticateToken, async (req, res) => {
  const { calendarId } = req.params;
  const { title, description, location, date, time, endTime } = req.body;

  try {
    // Get calendar to verify ownership
    const { data: calendar, error: calError } = await supabase
      .from('calendars')
      .select('id')
      .eq('google_calendar_id', calendarId)
      .eq('owner_email', req.userEmail)
      .single();

    if (calError || !calendar) {
      return res.status(404).json({ error: 'Calendar not found' });
    }

    // Create event in Supabase
    const eventId = generateToken().substring(0, 16);
    
    const { data: event, error: eventError } = await supabase
      .from('events')
      .insert([{
        calendar_id: calendar.id,
        google_event_id: eventId,
        title: title,
        description: description,
        location: location,
        event_date: date,
        start_time: time,
        end_time: endTime
      }])
      .select()
      .single();

    if (eventError) {
      console.error('Error creating event:', eventError);
      return res.status(500).json({ error: 'Failed to create event' });
    }

    res.json({
      id: event.google_event_id,
      summary: event.title,
      start: { dateTime: `${date}T${time}` },
      end: { dateTime: `${date}T${endTime}` }
    });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// ROUTE 8: Delete event
app.delete('/api/calendars/:calendarId/events/:eventId', authenticateToken, async (req, res) => {
  const { calendarId, eventId } = req.params;

  try {
    // Verify calendar ownership
    const { data: calendar } = await supabase
      .from('calendars')
      .select('id')
      .eq('google_calendar_id', calendarId)
      .eq('owner_email', req.userEmail)
      .single();

    if (!calendar) {
      return res.status(404).json({ error: 'Calendar not found' });
    }

    // Delete event
    const { error: deleteError } = await supabase
      .from('events')
      .delete()
      .eq('google_event_id', eventId)
      .eq('calendar_id', calendar.id);

    if (deleteError) {
      console.error('Error deleting event:', deleteError);
      return res.status(500).json({ error: 'Failed to delete event' });
    }

    res.json({ success: true, message: 'Event deleted' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ============================================
// SUBSCRIPTION FEED ROUTES (Public - No Auth)
// ============================================

// ROUTE 9: Get subscription feed (ICS file)
app.get('/api/subscriptions/:calendarId/feed.ics', async (req, res) => {
  const { calendarId } = req.params;

  try {
    // Get calendar
    const { data: calendar, error: calError } = await supabase
      .from('calendars')
      .select('*')
      .eq('google_calendar_id', calendarId)
      .single();

    if (calError || !calendar) {
      return res.status(404).send('Calendar not found');
    }

    // Get events
    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('calendar_id', calendar.id)
      .order('event_date', { ascending: true });

    if (eventsError) {
      console.error('Error fetching events:', eventsError);
    }

    // Generate ICS feed
    const calendarData = {
      id: calendar.google_calendar_id,
      name: calendar.name,
      description: calendar.description,
      events: events || []
    };

    const icsContent = generateCalendarFeed(calendarData);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${calendar.name}.ics"`);
    res.send(icsContent);
  } catch (error) {
    console.error('Error generating feed:', error);
    res.status(500).send('Failed to generate calendar feed');
  }
});

// ============================================
// UTILITY ROUTES
// ============================================

// Health check
app.get('/health', async (req, res) => {
  const { count } = await supabase
    .from('calendars')
    .select('*', { count: 'exact', head: true });

  res.json({
    status: 'ok',
    calendars: count || 0,
    database: 'supabase',
    auth: 'jwt-token'
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔐 JWT token auth enabled`);
  console.log(`🗄️  Database: Supabase`);
  console.log(`📅 Calendar feeds: /api/subscriptions/{calendarId}/feed.ics`);
});
