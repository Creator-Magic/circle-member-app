const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Parse allowed origins from environment variable
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://0.0.0.0:8080'];

// Parse paid member tags from environment variable
const paidMemberTags = process.env.PAID_MEMBER_TAGS
  ? process.env.PAID_MEMBER_TAGS.split(',').map(tag => tag.trim().toLowerCase())
  : ['paid', 'premium', 'subscriber', 'member', 'vip', 'pro'];

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test database connection
pool.on('connect', () => {
  console.log('Connected to the PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://0.0.0.0:8080');
  allowedOrigins.push('http://0.0.0.0:3000');
}

console.log('Allowed CORS origins:', allowedOrigins);
console.log('Paid member tags:', paidMemberTags);
console.log('Database URL configured:', process.env.DATABASE_URL ? 'Yes' : 'No');

// In-memory store for temporary admin tokens (in production, use Redis)
const adminTokens = new Map();

// Circle Admin API configuration
const CIRCLE_ADMIN_API_TOKEN = process.env.CIRCLE_ADMIN_API_TOKEN;
const CIRCLE_ADMIN_API_BASE = 'https://app.circle.so';

// Function to get admin tag ID by name
async function getAdminTagIdByName(tagName) {
  if (!CIRCLE_ADMIN_API_TOKEN) {
    console.log('CIRCLE_ADMIN_API_TOKEN not configured, skipping tag management');
    return null;
  }

  try {
    // Get all admin tags
    const response = await axios.get(
      `${CIRCLE_ADMIN_API_BASE}/api/admin/v2/member_tags`,
      {
        headers: {
          'Authorization': `Bearer ${CIRCLE_ADMIN_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Admin tags API response:', JSON.stringify(response.data, null, 2));
    
    // The response structure is { page: 1, records: [...] }
    const tags = response.data?.records || response.data || [];
    
    if (!Array.isArray(tags)) {
      console.error('Unexpected tags response format:', typeof tags);
      return null;
    }
    
    // Find the tag with matching name
    const adminTag = tags.find(tag => tag.name === tagName);
    
    if (adminTag) {
      console.log(`Found admin tag: name="${adminTag.name}", admin_id=${adminTag.id}`);
      return adminTag.id;
    } else {
      console.log(`Admin tag with name "${tagName}" not found in ${tags.length} tags`);
      return null;
    }
  } catch (error) {
    console.error('Error fetching admin tags:', error.response?.data || error.message);
    return null;
  }
}

// Function to delete a member tag using Circle Admin API
async function deleteMemberTag(userEmail, memberTagId) {
  if (!CIRCLE_ADMIN_API_TOKEN) {
    console.log('CIRCLE_ADMIN_API_TOKEN not configured, cannot delete tag');
    return false;
  }

  try {
    console.log(`Attempting to delete tag: email=${userEmail}, tag_id=${memberTagId}`);
    
    const response = await axios.delete(
      `${CIRCLE_ADMIN_API_BASE}/api/admin/v2/tagged_members`,
      {
        params: {
          user_email: userEmail,
          member_tag_id: memberTagId
        },
        headers: {
          'Authorization': `Bearer ${CIRCLE_ADMIN_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`Successfully deleted member tag ID ${memberTagId} for user ${userEmail}:`, response.data);
    return true;
  } catch (error) {
    console.error('Error deleting member tag:', error.response?.data || error.message);
    if (error.response?.status) {
      console.error('Response status:', error.response.status);
    }
    return false;
  }
}

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (same-origin requests, server-side requests, mobile apps, etc.)
    if (!origin) {
      // Log only in development
      if (process.env.NODE_ENV !== 'production') {
        console.log('Request with no origin header (likely same-origin or server-side)');
      }
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    
    // In development, be more permissive
    if (process.env.NODE_ENV !== 'production') {
      console.log('Development mode: allowing origin:', origin);
      return callback(null, true);
    }
    
    // In production, block unknown origins
    console.warn('CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Endpoint to provide client configuration
app.get('/api/config', (req, res) => {
  res.json({
    allowedOrigins: allowedOrigins,
    requireIframe: process.env.REQUIRE_IFRAME === 'true',
    disableEmailOnlyAuth: process.env.DISABLE_EMAIL_ONLY_AUTH === 'true',
    circleDomain: process.env.CIRCLE_COMMUNITY_DOMAIN,
    appDomain: process.env.APP_DOMAIN,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Security middleware to check if request is from iframe
function checkIframeEmbedding(req, res, next) {
  // Only enforce in production with explicit flag
  if (process.env.REQUIRE_IFRAME === 'true' && process.env.NODE_ENV === 'production') {
    const referer = req.headers.referer || req.headers.referrer;
    const origin = req.headers.origin;
    const secFetchDest = req.headers['sec-fetch-dest'];
    
    console.log('Security check - Referer:', referer);
    console.log('Security check - Origin:', origin);
    console.log('Security check - Sec-Fetch-Dest:', secFetchDest);
    
    // Allow requests from our own app domain (iframe making requests to itself)
    const appDomain = process.env.APP_DOMAIN;
    const circleDomain = process.env.CIRCLE_COMMUNITY_DOMAIN;
    
    // If referer is from our app domain, it's likely an iframe making API calls
    if (referer && appDomain && referer.includes(appDomain)) {
      console.log('Request from app domain (iframe API call) - allowing');
      return next();
    }
    
    // Check if it's a direct browser navigation (not an API call from iframe)
    if (secFetchDest === 'document' || secFetchDest === 'navigate') {
      // This is someone trying to load the page directly
      // Only allow if referer is from Circle domain
      if (!referer || !circleDomain || !referer.includes(circleDomain)) {
        console.error('Security: Direct navigation not from Circle domain');
        return res.status(403).json({ 
          error: 'Forbidden',
          message: 'Direct access not allowed. Please access through Circle.' 
        });
      }
    }
    
    // For API calls (empty or cors sec-fetch-dest), allow from allowed origins
    // This handles the iframe making requests back to the server
    console.log('API request - allowing');
  }
  next();
}

app.post('/api/auth', checkIframeEmbedding, async (req, res) => {
  try {
    const { email, community_member_id, sso_id, name, avatar_url } = req.body;
    
    console.log('=== AUTH REQUEST START ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    
    // Security: Disable email-only authentication in production
    if (process.env.DISABLE_EMAIL_ONLY_AUTH === 'true') {
      // Require either a valid postMessage auth (with name) or member_id/sso_id
      if (email && !name && !community_member_id && !sso_id) {
        console.error('Security: Email-only authentication is disabled');
        return res.status(403).json({ 
          error: 'Authentication failed',
          message: 'Email-only authentication is disabled for security. Please access this app through Circle.' 
        });
      }
    }
    
    if (!process.env.CIRCLE_API_TOKEN) {
      console.error('ERROR: Circle API token not configured');
      return res.status(500).json({ error: 'Circle API token not configured' });
    }

    // Validate and clean authentication parameters
    const authData = {};
    
    // Check for template variables that weren't replaced
    if (email) {
      if (email.includes('{{') && email.includes('}}')) {
        console.error('ERROR: Email contains unprocessed template variable:', email);
        return res.status(400).json({ 
          error: 'Invalid email format',
          message: 'The email parameter contains an unprocessed template variable. Please provide a valid email address.',
          details: 'Template variables like {{member.email}} should be replaced with actual values before accessing this endpoint.'
        });
      }
      
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        console.error('ERROR: Invalid email format:', email);
        return res.status(400).json({ 
          error: 'Invalid email format',
          message: 'Please provide a valid email address.',
          details: `Received email: ${email}`
        });
      }
      
      authData.email = email;
    }
    
    if (community_member_id) {
      if (community_member_id.includes('{{') && community_member_id.includes('}}')) {
        console.error('ERROR: Community member ID contains unprocessed template variable:', community_member_id);
        return res.status(400).json({ 
          error: 'Invalid community member ID format',
          message: 'The member ID parameter contains an unprocessed template variable. Please provide a valid member ID.',
          details: 'Template variables should be replaced with actual values before accessing this endpoint.'
        });
      }
      authData.community_member_id = community_member_id;
    }
    
    if (sso_id) {
      if (sso_id.includes('{{') && sso_id.includes('}}')) {
        console.error('ERROR: SSO ID contains unprocessed template variable:', sso_id);
        return res.status(400).json({ 
          error: 'Invalid SSO ID format',
          message: 'The SSO ID parameter contains an unprocessed template variable. Please provide a valid SSO ID.',
          details: 'Template variables should be replaced with actual values before accessing this endpoint.'
        });
      }
      authData.sso_id = sso_id;
    }

    console.log('Auth data being sent to Circle API:', JSON.stringify(authData, null, 2));
    console.log('Circle API URL:', 'https://app.circle.so/api/v1/headless/auth_token');

    const authResponse = await axios.post(
      'https://app.circle.so/api/v1/headless/auth_token',
      authData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.CIRCLE_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Circle API auth response status:', authResponse.status);
    console.log('Circle API auth response data:', JSON.stringify(authResponse.data, null, 2));

    const { access_token, community_member_id: memberId } = authResponse.data;

    if (!access_token) {
      console.error('ERROR: No access_token received from Circle API');
      throw new Error('No access token received from Circle API');
    }

    if (!memberId) {
      console.error('ERROR: No community_member_id received from Circle API');
      throw new Error('No community member ID received from Circle API');
    }

    console.log('Retrieved access_token (first 10 chars):', access_token.substring(0, 10) + '...');
    console.log('Retrieved community_member_id:', memberId);

    // Get member profile using the correct endpoint
    let memberData = null;
    
    try {
      // Use the /community_member endpoint (correct one from API docs)
      const memberUrl = `https://app.circle.so/api/headless/v1/community_member`;
      console.log('Fetching member data from:', memberUrl);
      
      const memberResponse = await axios.get(memberUrl, {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Member API response status:', memberResponse.status);
      console.log('Member API response data:', JSON.stringify(memberResponse.data, null, 2));
      memberData = memberResponse.data;
      
      // Extract useful fields for display
      if (memberData) {
        // Ensure we have all the fields we need
        memberData.id = memberData.id || memberId;
        memberData.community_member_id = memberId;
        memberData.community_id = authResponse.data.community_id;
        
        // Check for paid status via tags or other indicators
        memberData.is_paid = false;
        
        // Ensure tags is an array (Circle might return it as string or array)
        // Check multiple possible fields where tags might be stored
        const possibleTags = memberData.tags || memberData.labels || memberData.member_tags || [];
        
        if (possibleTags) {
          if (typeof possibleTags === 'string') {
            // If tags is a comma-separated string, split it
            memberData.tags = possibleTags.split(',').map(tag => tag.trim());
          } else if (Array.isArray(possibleTags)) {
            // If it's an array of objects with name/label properties
            memberData.tags = possibleTags.map(tag => {
              if (typeof tag === 'string') return tag;
              if (tag.name) return tag.name;
              if (tag.label) return tag.label;
              if (tag.title) return tag.title;
              return String(tag);
            });
          } else {
            memberData.tags = [];
          }
        } else {
          memberData.tags = [];
        }
        
        // Paid status detection - using tags ONLY
        let isPaidMember = false;
        
        // Check member tags against configured paid tags
        if (memberData.tags && Array.isArray(memberData.tags) && memberData.tags.length > 0) {
          isPaidMember = memberData.tags.some(tag => 
            typeof tag === 'string' && paidMemberTags.some(paidTag => tag.toLowerCase().includes(paidTag))
          );
        }
        
        memberData.is_paid = isPaidMember;
        
        console.log('Paid status detection (tags only):', {
          email: memberData.email,
          tags: memberData.tags || [],
          matched_paid_tag: isPaidMember,
          configured_paid_tags: paidMemberTags
        });
      }
      
    } catch (memberError) {
      console.log('Community member endpoint failed. Trying public profile...');
      
      try {
        // Try public profile endpoint as fallback
        const publicProfileUrl = `https://app.circle.so/api/headless/v1/community_members/${memberId}/public_profile`;
        const profileResponse = await axios.get(publicProfileUrl, {
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
          }
        });
        
        console.log('Public profile API response status:', profileResponse.status);
        console.log('Public profile API response data:', JSON.stringify(profileResponse.data, null, 2));
        memberData = profileResponse.data;
        
      } catch (profileError) {
        console.log('All member endpoints failed. Using data from auth response...');
        
        // If all endpoints fail, construct member data from what we have
        memberData = {
          id: memberId,
          community_member_id: memberId,
          community_id: authResponse.data.community_id,
          email: email || authData.email,
          name: req.body.name || 'Circle Member',
          avatar_url: req.body.avatar_url || null,
          is_paid: false,
          tags: []
        };
      }
    }

    // Database integration: Upsert member data and handle credits
    if (memberData && memberData.id && process.env.DATABASE_URL) {
      try {
        console.log('=== DATABASE INTEGRATION START ===');
        console.log('Upserting member data into database...');
        
        // First, check the member's CURRENT status in DB before updating
        const existingMemberQuery = await pool.query(
          'SELECT id, is_paid, tags FROM members WHERE circle_member_id = $1',
          [memberData.id || memberData.community_member_id]
        );
        const existingMember = existingMemberQuery.rows[0];
        const previousPaidStatus = existingMember?.is_paid || false;
        const previousTags = existingMember?.tags || [];

        // 1. UPSERT Member Data
        const upsertQuery = `
          INSERT INTO members (
            circle_member_id, circle_user_id, email, name, avatar_url, 
            is_admin, is_moderator, is_paid, tags, last_seen_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          ON CONFLICT (circle_member_id)
          DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            avatar_url = EXCLUDED.avatar_url,
            is_admin = EXCLUDED.is_admin,
            is_moderator = EXCLUDED.is_moderator,
            is_paid = EXCLUDED.is_paid,
            tags = EXCLUDED.tags,
            last_seen_at = NOW(),
            updated_at = NOW()
          RETURNING id, first_seen_at, created_at;
        `;
        
        // Extract admin and moderator status from Circle's roles object
        const isAdmin = memberData.roles?.admin || memberData.is_admin || false;
        const isModerator = memberData.roles?.moderator || memberData.is_moderator || false;
        
        console.log('Role detection:', {
          'roles object': memberData.roles,
          'extracted isAdmin': isAdmin,
          'extracted isModerator': isModerator
        });
        
        // Determine paid status before upserting
        const currentIsPaid = memberData.is_paid !== undefined ? memberData.is_paid : 
          (memberData.tags && memberData.tags.some(tag => 
            typeof tag === 'string' && paidMemberTags.some(paidTag => tag.toLowerCase().includes(paidTag))
          )) || false;
        
        const memberResult = await pool.query(upsertQuery, [
          memberData.id || memberData.community_member_id,
          memberData.user_id,
          memberData.email || email || authData.email,
          memberData.name || req.body.name || 'Circle Member',
          memberData.avatar_url || req.body.avatar_url,
          isAdmin,
          isModerator,
          currentIsPaid,
          JSON.stringify(memberData.tags || memberData.member_tags || [])
        ]);

        const { id: dbMemberId, first_seen_at: firstSeenAt } = memberResult.rows[0];
        
        // Check if this is a new user (created within the last 30 seconds)
        const isNewUser = (new Date() - new Date(firstSeenAt)) < 30000;
        
        console.log('Member upserted with DB ID:', dbMemberId);
        console.log('Is new user:', isNewUser);
        
        // Ensure paid status is always detected based on tags
        // Update memberData.is_paid to match what was saved to database
        memberData.is_paid = currentIsPaid;
        if (memberData.tags) {
          console.log('Paid status verification:', {
            tags: memberData.tags,
            is_paid: memberData.is_paid,
            configured_paid_tags: paidMemberTags
          });
        }

        // 2. Handle Credits (Initial Grant & Monthly Replenishment)
        console.log('=== STARTING CREDIT PROCESSING ===');
        let creditsResult = await pool.query(
          'SELECT * FROM member_credits WHERE member_id = $1', 
          [dbMemberId]
        );
        console.log('Credits query result:', creditsResult.rows.length > 0 ? 'found' : 'not found');
        
        if (creditsResult.rows.length === 0 || isNewUser) {
          // New user or no credit record exists, grant initial credits
          console.log(`New user or missing credits detected (DB ID: ${dbMemberId}). Granting initial credits.`);
          
          const initialCredits = memberData.is_paid
            ? parseInt(process.env.INITIAL_CREDITS_PAID, 10) || 100
            : parseInt(process.env.INITIAL_CREDITS_FREE, 10) || 10;

          creditsResult = await pool.query(`
            INSERT INTO member_credits (member_id, credits_balance, last_refreshed_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (member_id)
            DO UPDATE SET
              credits_balance = EXCLUDED.credits_balance,
              last_refreshed_at = EXCLUDED.last_refreshed_at,
              updated_at = NOW()
            RETURNING *
          `, [dbMemberId, initialCredits]);
          
          // Log the initial credit grant
          await pool.query(`
            INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
            VALUES ($1, $2, $3, $4, $5)
          `, [
            dbMemberId,
            initialCredits,
            'initial_grant',
            initialCredits,
            `Initial credit grant: ${memberData.is_paid ? 'paid' : 'free'} member`
          ]);
          
        } else {
          // Returning user, check for monthly refresh AND status change
          const creditsRecord = creditsResult.rows[0];
          const lastRefresh = new Date(creditsRecord.last_refreshed_at);
          const oneMonthAgo = new Date();
          oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

          // Check if member's paid status changed (using the status we captured BEFORE updating DB)
          const tagsChanged = JSON.stringify(previousTags) !== JSON.stringify(memberData.tags || []);
          
          if (previousPaidStatus !== memberData.is_paid || tagsChanged) {
            console.log(`Member ${memberData.email} status/tags changed:`, {
              previousPaidStatus,
              currentPaidStatus: memberData.is_paid,
              previousTags,
              currentTags: memberData.tags
            });
            
            // If they upgraded to paid, give them additional credits
            if (!previousPaidStatus && memberData.is_paid) {
              const upgradeBonus = (parseInt(process.env.INITIAL_CREDITS_PAID, 10) || 100) - 
                                   (parseInt(process.env.INITIAL_CREDITS_FREE, 10) || 10);
              
              const newBalance = creditsRecord.credits_balance + upgradeBonus;
              
              creditsResult = await pool.query(`
                UPDATE member_credits 
                SET credits_balance = $1, updated_at = NOW()
                WHERE member_id = $2 
                RETURNING *
              `, [newBalance, dbMemberId]);
              
              // Log the upgrade bonus
              await pool.query(`
                INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
                VALUES ($1, $2, $3, $4, $5)
              `, [
                dbMemberId,
                upgradeBonus,
                'upgrade_bonus',
                newBalance,
                'Credit bonus for upgrading to paid membership'
              ]);
              
              console.log(`Added ${upgradeBonus} upgrade bonus credits for ${memberData.email}`);
            }
          }

          // Regular monthly refresh check
          if (lastRefresh < oneMonthAgo) {
            console.log(`User DB ID ${dbMemberId} is eligible for credit refresh.`);
            
            const monthlyCredits = memberData.is_paid
              ? parseInt(process.env.MONTHLY_CREDITS_PAID, 10) || 100
              : parseInt(process.env.MONTHLY_CREDITS_FREE, 10) || 10;
            
            const currentBalance = creditsResult.rows[0]?.credits_balance || creditsRecord.credits_balance;
            const newBalance = currentBalance + monthlyCredits;
            
            creditsResult = await pool.query(`
              UPDATE member_credits 
              SET credits_balance = $1, last_refreshed_at = NOW(), updated_at = NOW()
              WHERE member_id = $2 
              RETURNING *
            `, [newBalance, dbMemberId]);
            
            // Log the monthly refresh
            await pool.query(`
              INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
              VALUES ($1, $2, $3, $4, $5)
            `, [
              dbMemberId,
              monthlyCredits,
              'monthly_refresh',
              newBalance,
              `Monthly credit refresh: ${memberData.is_paid ? 'paid' : 'free'} member`
            ]);
          }
        }
        
        console.log('=== ABOUT TO PROCESS PURCHASE TAGS ===');
        console.log('Current execution point reached');
        
        try {
          // 3. Process One-Time Purchase Tags
          // Check for numeric tags (e.g., "$10", "$50", "$100", "10", "50", "100")
          const purchaseTags = [];
          const processedTags = [];
        
        console.log('=== PURCHASE TAG DETECTION START ===');
        console.log('memberData.tags:', memberData.tags);
        console.log('Is array?', Array.isArray(memberData.tags));
        
        if (memberData.tags && Array.isArray(memberData.tags)) {
          for (const tag of memberData.tags) {
            // Match tags like "$10", "$50", "$100" or just "10", "50", "100"
            const tagStr = String(tag).trim();
            const purchaseMatch = tagStr.match(/^\$?(\d+)$/);
            
            console.log(`Checking tag "${tagStr}":`, { purchaseMatch });
            
            if (purchaseMatch) {
              const creditAmount = parseInt(purchaseMatch[1], 10);
              
              // Only process reasonable credit amounts (1-10000)
              if (creditAmount > 0 && creditAmount <= 10000) {
                console.log(`Valid purchase tag found: "${tagStr}" = ${creditAmount} credits`);
                purchaseTags.push({
                  tag: tagStr,
                  credits: creditAmount
                });
              }
            }
          }
        }
        
        console.log('Purchase tags found:', purchaseTags);
        console.log('=== PURCHASE TAG DETECTION END ===');
        
        // Process purchase tags immediately (no time limit)
        if (purchaseTags.length > 0) {
          console.log(`Found purchase tags for ${memberData.email}:`, purchaseTags);
          
          let totalCreditsToAdd = 0;
          const tagsToProcess = [];
          const tagsToDelete = [];
          
          // Process all numeric tags immediately and prepare for deletion
          for (const purchase of purchaseTags) {
            totalCreditsToAdd += purchase.credits;
            tagsToProcess.push(purchase);
            
            // Get the admin tag ID for deletion
            const adminTagId = await getAdminTagIdByName(purchase.tag);
            
            if (adminTagId) {
              tagsToDelete.push({
                id: adminTagId,
                name: purchase.tag,
                credits: purchase.credits
              });
              console.log(`Will process and delete purchase tag "${purchase.tag}" (admin_id: ${adminTagId}) for ${purchase.credits} credits`);
            } else {
              console.log(`Will process purchase tag "${purchase.tag}" for ${purchase.credits} credits (couldn't find admin tag ID for deletion)`);
            }
          }

          // If there are any new credits to add, perform one transaction
          if (totalCreditsToAdd > 0) {
            console.log(`Processing ${tagsToProcess.length} new purchase tags for a total of ${totalCreditsToAdd} credits.`);
            
            await pool.query('BEGIN');
            try {
              const currentBalance = creditsResult.rows[0].credits_balance;
              const newBalance = currentBalance + totalCreditsToAdd;

              // 1. Update the balance once
              await pool.query(`
                UPDATE member_credits 
                SET credits_balance = $1, updated_at = NOW() 
                WHERE member_id = $2
              `, [newBalance, dbMemberId]);

              // 2. Log all processed tags and history records
              for (const purchase of tagsToProcess) {
                // Log the processed tag for audit purposes (no longer prevents reprocessing)
                await pool.query(`
                  INSERT INTO processed_purchase_tags (member_id, tag_value, credits_granted) 
                  VALUES ($1, $2, $3)
                `, [dbMemberId, purchase.tag, purchase.credits]);
                
                await pool.query(`
                  INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes) 
                  VALUES ($1, $2, $3, $4, $5)
                `, [
                  dbMemberId, 
                  purchase.credits, 
                  'purchase', 
                  newBalance, 
                  `One-time purchase: ${purchase.tag}`
                ]);
              }
              
              await pool.query('COMMIT');

              // Update local state for the response
              creditsResult.rows[0].credits_balance = newBalance;
              processedTags.push(...tagsToProcess.map(p => p.tag));
              memberData.processed_purchase_tags = processedTags;
              
              console.log(`Successfully granted a total of ${totalCreditsToAdd} credits from tags:`, processedTags);
              
              // Delete the tags from Circle after successful credit processing
              if (tagsToDelete.length > 0) {
                console.log(`Deleting ${tagsToDelete.length} purchase tags from Circle...`);
                for (const tagInfo of tagsToDelete) {
                  const deleteSuccess = await deleteMemberTag(memberData.email, tagInfo.id);
                  if (deleteSuccess) {
                    console.log(`Deleted tag "${tagInfo.name}" (${tagInfo.credits} credits) from Circle`);
                  } else {
                    console.log(`Failed to delete tag "${tagInfo.name}" from Circle, but credits were already added`);
                  }
                }
              }

            } catch (txError) {
              await pool.query('ROLLBACK');
              console.error(`Failed to process batch of purchase tags:`, txError);
            }
          }
        }
        
        } catch (purchaseTagError) {
          console.error('=== PURCHASE TAG PROCESSING ERROR ===');
          console.error('Error processing purchase tags:', purchaseTagError);
          console.error('Stack trace:', purchaseTagError.stack);
        }
        
        // 4. Enhance memberData with credits and database info
        const finalCreditsData = creditsResult.rows[0];
        memberData.db_id = dbMemberId;
        memberData.credits_balance = finalCreditsData.credits_balance;
        memberData.credits_last_refreshed = finalCreditsData.last_refreshed_at;
        memberData.is_new_user = isNewUser;
        
        // Ensure admin/moderator status is available for frontend
        memberData.is_admin = isAdmin;
        memberData.is_moderator = isModerator;
        
        console.log('Final member data with credits:', {
          db_id: memberData.db_id,
          credits_balance: memberData.credits_balance,
          is_new_user: memberData.is_new_user,
          is_admin: memberData.is_admin,
          is_moderator: memberData.is_moderator
        });
        
        console.log('=== DATABASE INTEGRATION SUCCESS ===');
        
      } catch (dbError) {
        console.error('=== DATABASE ERROR ===');
        console.error('Database operation failed:', dbError.message);
        console.error('Full error:', dbError);
        
        // Don't fail the auth request, just log the error
        // The user can still authenticate even if DB operations fail
        memberData.db_error = 'Database operations failed, but authentication succeeded';
        memberData.credits_balance = 0; // Fallback
      }
    } else if (!process.env.DATABASE_URL) {
      console.log('Database URL not configured, skipping database operations');
      memberData.credits_balance = 0; // Fallback for no DB
    }

    console.log('=== AUTH REQUEST SUCCESS ===');

    res.json({
      success: true,
      member: memberData,
      access_token: access_token,
      refresh_token: authResponse.data.refresh_token,
      expires_at: authResponse.data.access_token_expires_at
    });

  } catch (error) {
    console.error('=== AUTH ERROR START ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    
    if (error.response) {
      console.error('HTTP Error Response:');
      console.error('  Status:', error.response.status);
      console.error('  Status Text:', error.response.statusText);
      console.error('  Headers:', JSON.stringify(error.response.headers, null, 2));
      console.error('  Data:', JSON.stringify(error.response.data, null, 2));
    }
    
    if (error.request) {
      console.error('Request details:');
      console.error('  Method:', error.request.method);
      console.error('  URL:', error.request.url || error.request.path);
      console.error('  Headers:', JSON.stringify(error.request.getHeaders ? error.request.getHeaders() : 'N/A', null, 2));
    }
    
    console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    console.error('=== AUTH ERROR END ===');
    
    res.status(error.response?.status || 500).json({ 
      error: 'Authentication failed',
      details: error.response?.data || error.message,
      debug_info: {
        error_type: error.constructor.name,
        has_response: !!error.response,
        has_request: !!error.request,
        response_status: error.response?.status,
        response_data: error.response?.data
      }
    });
  }
});

// New endpoint for cookie-based authentication (for iframe embedding)
app.post('/api/auth/cookies', async (req, res) => {
  try {
    const { access_token, redirect_to } = req.body;
    
    console.log('=== COOKIE AUTH REQUEST START ===');
    console.log('Access token provided:', access_token ? 'Yes (length: ' + access_token.length + ')' : 'No');
    console.log('Redirect to:', redirect_to);
    
    if (!access_token) {
      console.error('ERROR: No access token provided');
      return res.status(400).json({ 
        error: 'No access token provided',
        message: 'An access token is required for cookie-based authentication'
      });
    }
    
    // Use Circle's cookies API to set session cookies
    const communityDomain = process.env.CIRCLE_COMMUNITY_DOMAIN || 'community.circle.so';
    const cookiesUrl = `https://${communityDomain}/api/headless/v1/cookies`;
    
    console.log('Setting cookies via:', cookiesUrl);
    
    const cookieResponse = await axios.post(cookiesUrl, {}, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Cookie response status:', cookieResponse.status);
    console.log('Cookie response:', JSON.stringify(cookieResponse.data, null, 2));
    console.log('=== COOKIE AUTH SUCCESS ===');
    
    res.json({
      success: true,
      message: 'Session cookies set successfully',
      redirect_to: redirect_to || '/'
    });
    
  } catch (error) {
    console.error('=== COOKIE AUTH ERROR START ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    
    if (error.response) {
      console.error('HTTP Error Response:');
      console.error('  Status:', error.response.status);
      console.error('  Data:', JSON.stringify(error.response.data, null, 2));
    }
    
    console.error('=== COOKIE AUTH ERROR END ===');
    
    res.status(error.response?.status || 500).json({ 
      error: 'Cookie authentication failed',
      details: error.response?.data || error.message
    });
  }
});

// Generate secure admin token for popup window access
app.post('/api/admin/generate-token', async (req, res) => {
  try {
    const { circle_member_id } = req.body;
    
    if (!circle_member_id) {
      return res.status(400).json({
        error: 'Missing circle_member_id',
        message: 'Member ID required for admin token generation'
      });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(501).json({
        error: 'Database not configured',
        message: 'Admin features require database configuration'
      });
    }

    // Verify the user is actually an admin in our database
    const result = await pool.query(`
      SELECT is_admin, name, email 
      FROM members 
      WHERE circle_member_id = $1 AND is_admin = true
    `, [circle_member_id]);

    if (result.rows.length === 0) {
      console.warn(`Admin token generation denied for member ${circle_member_id} - not an admin`);
      return res.status(403).json({
        error: 'Access denied',
        message: 'Admin privileges required'
      });
    }

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store token with admin info
    adminTokens.set(token, {
      circle_member_id,
      name: result.rows[0].name,
      email: result.rows[0].email,
      expiresAt,
      createdAt: new Date()
    });

    console.log(`Admin token generated for ${result.rows[0].name} (${result.rows[0].email}), expires at ${expiresAt.toISOString()}`);

    // Clean up expired tokens periodically
    cleanupExpiredTokens();

    res.json({
      success: true,
      token,
      expiresAt: expiresAt.toISOString(),
      adminUrl: `/admin.html?token=${token}`
    });

  } catch (error) {
    console.error('Generate admin token error:', error.message);
    res.status(500).json({
      error: 'Failed to generate admin token',
      details: error.message
    });
  }
});

// Helper function to clean up expired tokens
function cleanupExpiredTokens() {
  const now = new Date();
  for (const [token, data] of adminTokens.entries()) {
    if (data.expiresAt < now) {
      adminTokens.delete(token);
    }
  }
}

// Check if user has valid Circle session cookies
app.get('/api/member/check', async (req, res) => {
  try {
    console.log('=== MEMBER SESSION CHECK START ===');
    console.log('Cookies:', req.headers.cookie ? 'Present' : 'None');
    
    // Look for Circle-specific cookies
    const cookies = req.headers.cookie || '';
    const hasCircleSession = cookies.includes('_circle_session') || 
                            cookies.includes('circle_member_token') ||
                            cookies.includes('circle_access_token');
    
    console.log('Has Circle session cookie:', hasCircleSession);
    console.log('=== MEMBER SESSION CHECK END ===');
    
    if (hasCircleSession) {
      res.json({
        success: true,
        authenticated: true,
        message: 'Circle session detected'
      });
    } else {
      res.json({
        success: false,
        authenticated: false,
        message: 'No Circle session found'
      });
    }
    
  } catch (error) {
    console.error('Session check error:', error.message);
    
    res.status(500).json({
      success: false,
      authenticated: false,
      error: 'Session check failed'
    });
  }
});

// Credit system endpoints
// Get member's current credit balance
app.get('/api/credits/:circle_member_id', async (req, res) => {
  try {
    const { circle_member_id } = req.params;
    
    if (!process.env.DATABASE_URL) {
      return res.status(501).json({
        error: 'Database not configured',
        message: 'Credit system requires database configuration'
      });
    }

    const result = await pool.query(`
      SELECT mc.credits_balance, mc.last_refreshed_at, m.name, m.email, m.is_paid
      FROM member_credits mc
      JOIN members m ON mc.member_id = m.id
      WHERE m.circle_member_id = $1
    `, [circle_member_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Member not found',
        message: 'No credit record found for this member'
      });
    }

    res.json({
      success: true,
      credits: result.rows[0]
    });

  } catch (error) {
    console.error('Get credits error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch credits',
      details: error.message
    });
  }
});

// Spend credits for an action
app.post('/api/credits/spend', async (req, res) => {
  try {
    const { circle_member_id, action_type, credits_cost = 1, metadata = {} } = req.body;
    
    if (!process.env.DATABASE_URL) {
      return res.status(501).json({
        error: 'Database not configured',
        message: 'Credit system requires database configuration'
      });
    }

    if (!circle_member_id || !action_type) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'circle_member_id and action_type are required'
      });
    }

    // Start a transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get member and current credits
      const memberResult = await client.query(`
        SELECT m.id, mc.credits_balance 
        FROM members m
        JOIN member_credits mc ON m.id = mc.member_id
        WHERE m.circle_member_id = $1
        FOR UPDATE
      `, [circle_member_id]);

      if (memberResult.rows.length === 0) {
        throw new Error('Member or credit record not found');
      }

      const { id: memberId, credits_balance } = memberResult.rows[0];
      
      if (credits_balance < credits_cost) {
        throw new Error('Insufficient credits');
      }

      // Deduct credits
      const newBalance = credits_balance - credits_cost;
      await client.query(`
        UPDATE member_credits 
        SET credits_balance = $1, updated_at = NOW()
        WHERE member_id = $2
      `, [newBalance, memberId]);

      // Log the action
      const actionResult = await client.query(`
        INSERT INTO app_actions (member_id, action_type, credits_cost, metadata, success)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
      `, [memberId, action_type, credits_cost, JSON.stringify(metadata), true]);

      // Log credit history
      await client.query(`
        INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, reference_id, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        memberId,
        -credits_cost,
        'action_cost',
        newBalance,
        actionResult.rows[0].id,
        `Credits spent on ${action_type}`
      ]);

      await client.query('COMMIT');

      res.json({
        success: true,
        action_id: actionResult.rows[0].id,
        credits_spent: credits_cost,
        credits_remaining: newBalance,
        timestamp: actionResult.rows[0].created_at
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Spend credits error:', error.message);
    
    const statusCode = error.message === 'Insufficient credits' ? 402 : 
                      error.message.includes('not found') ? 404 : 500;
    
    res.status(statusCode).json({
      error: 'Failed to spend credits',
      message: error.message,
      details: statusCode === 500 ? error.message : undefined
    });
  }
});

// Get member's action history
app.get('/api/actions/:circle_member_id', async (req, res) => {
  try {
    const { circle_member_id } = req.params;
    const { limit = 50, offset = 0, action_type } = req.query;
    
    if (!process.env.DATABASE_URL) {
      return res.status(501).json({
        error: 'Database not configured',
        message: 'Action history requires database configuration'
      });
    }

    let query = `
      SELECT a.id, a.action_type, a.credits_cost, a.metadata, a.success, 
             a.error_message, a.created_at
      FROM app_actions a
      JOIN members m ON a.member_id = m.id
      WHERE m.circle_member_id = $1
    `;
    
    const params = [circle_member_id];
    
    if (action_type) {
      query += ` AND a.action_type = $${params.length + 1}`;
      params.push(action_type);
    }
    
    query += ` ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      actions: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        count: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get actions error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch action history',
      details: error.message
    });
  }
});

// Get member's credit history
app.get('/api/credits/:circle_member_id/history', async (req, res) => {
  try {
    const { circle_member_id } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    if (!process.env.DATABASE_URL) {
      return res.status(501).json({
        error: 'Database not configured',
        message: 'Credit history requires database configuration'
      });
    }

    const result = await pool.query(`
      SELECT ch.change_amount, ch.change_type, ch.balance_after, 
             ch.notes, ch.created_at, aa.action_type
      FROM credit_history ch
      JOIN members m ON ch.member_id = m.id
      LEFT JOIN app_actions aa ON ch.reference_id = aa.id
      WHERE m.circle_member_id = $1
      ORDER BY ch.created_at DESC
      LIMIT $2 OFFSET $3
    `, [circle_member_id, parseInt(limit), parseInt(offset)]);

    res.json({
      success: true,
      history: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        count: result.rows.length
      }
    });

  } catch (error) {
    console.error('Get credit history error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch credit history',
      details: error.message
    });
  }
});

// Admin endpoints - require database and valid admin token
function checkAdminToken(req, res, next) {
  if (!process.env.DATABASE_URL) {
    return res.status(501).json({
      error: 'Database not configured',
      message: 'Admin features require database configuration'
    });
  }
  
  // Get token from query parameter or Authorization header
  const token = req.query.token || 
    (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  
  if (!token) {
    return res.status(401).json({
      error: 'Admin token required',
      message: 'Valid admin token required to access this endpoint'
    });
  }

  // Check if token exists and is not expired
  const tokenData = adminTokens.get(token);
  if (!tokenData) {
    return res.status(401).json({
      error: 'Invalid token',
      message: 'Admin token is invalid or has expired'
    });
  }

  if (tokenData.expiresAt < new Date()) {
    adminTokens.delete(token);
    return res.status(401).json({
      error: 'Token expired',
      message: 'Admin token has expired, please generate a new one'
    });
  }

  // Add admin info to request for logging
  req.adminUser = tokenData;
  next();
}

// Get all members (admin only)
app.get('/api/admin/members', checkAdminToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.circle_member_id,
        m.name,
        m.email,
        m.is_admin,
        m.is_moderator,
        m.is_paid,
        m.first_seen_at,
        m.last_seen_at,
        COALESCE(mc.credits_balance, 0) as credits_balance
      FROM members m
      LEFT JOIN member_credits mc ON m.id = mc.member_id
      ORDER BY m.last_seen_at DESC
    `);

    res.json({
      success: true,
      members: result.rows
    });

  } catch (error) {
    console.error('Get members error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch members',
      details: error.message
    });
  }
});

// Get all credit balances (admin only)
app.get('/api/admin/credits', checkAdminToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        m.name,
        m.email,
        m.is_paid,
        mc.credits_balance,
        mc.last_refreshed_at
      FROM member_credits mc
      JOIN members m ON mc.member_id = m.id
      ORDER BY mc.credits_balance DESC
    `);

    res.json({
      success: true,
      credits: result.rows
    });

  } catch (error) {
    console.error('Get credits error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch credit balances',
      details: error.message
    });
  }
});

// Get recent actions (admin only)
app.get('/api/admin/actions', checkAdminToken, async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const result = await pool.query(`
      SELECT 
        aa.id,
        aa.action_type,
        aa.credits_cost,
        aa.metadata,
        aa.success,
        aa.error_message,
        aa.created_at,
        m.name as member_name,
        m.circle_member_id
      FROM app_actions aa
      JOIN members m ON aa.member_id = m.id
      ORDER BY aa.created_at DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      success: true,
      actions: result.rows
    });

  } catch (error) {
    console.error('Get actions error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch actions',
      details: error.message
    });
  }
});

// Get credit history (admin only)
app.get('/api/admin/credit-history', checkAdminToken, async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const result = await pool.query(`
      SELECT 
        ch.change_amount,
        ch.change_type,
        ch.balance_after,
        ch.notes,
        ch.created_at,
        ch.member_id,
        m.name as member_name,
        m.email as member_email
      FROM credit_history ch
      JOIN members m ON ch.member_id = m.id
      ORDER BY ch.created_at DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      success: true,
      history: result.rows
    });

  } catch (error) {
    console.error('Get credit history error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch credit history',
      details: error.message
    });
  }
});

// Get database stats (admin only)
app.get('/api/admin/stats', checkAdminToken, async (req, res) => {
  try {
    const [
      memberCount,
      totalCredits,
      totalActions,
      recentActions
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM members'),
      pool.query('SELECT COALESCE(SUM(credits_balance), 0) as total FROM member_credits'),
      pool.query('SELECT COUNT(*) as count FROM app_actions'),
      pool.query('SELECT COUNT(*) as count FROM app_actions WHERE created_at > NOW() - INTERVAL \'24 hours\'')
    ]);

    res.json({
      success: true,
      stats: {
        total_members: parseInt(memberCount.rows[0].count),
        total_credits: parseInt(totalCredits.rows[0].total),
        total_actions: parseInt(totalActions.rows[0].count),
        actions_24h: parseInt(recentActions.rows[0].count)
      }
    });

  } catch (error) {
    console.error('Get stats error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      details: error.message
    });
  }
});

// Manual credit refresh endpoint for admins
app.post('/api/admin/refresh-credits/:circle_member_id', checkAdminToken, async (req, res) => {
  try {
    const { circle_member_id } = req.params;
    const { bonus_credits = 0, force_refresh = false } = req.body;
    
    // Get member from database
    const memberResult = await pool.query(`
      SELECT m.id, m.email, m.name, m.is_paid, mc.credits_balance, mc.last_refreshed_at
      FROM members m
      LEFT JOIN member_credits mc ON m.id = mc.member_id
      WHERE m.circle_member_id = $1
    `, [circle_member_id]);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Member not found',
        message: 'No member found with the specified Circle member ID'
      });
    }

    const member = memberResult.rows[0];
    let totalCreditsAdded = 0;
    let operations = [];

    // Add bonus credits if specified
    if (bonus_credits > 0) {
      const newBalance = (member.credits_balance || 0) + bonus_credits;
      
      await pool.query(`
        UPDATE member_credits 
        SET credits_balance = $1, updated_at = NOW()
        WHERE member_id = $2
      `, [newBalance, member.id]);

      await pool.query(`
        INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        member.id,
        bonus_credits,
        'admin_bonus',
        newBalance,
        `Manual credit bonus added by admin ${req.adminUser.email}`
      ]);

      totalCreditsAdded += bonus_credits;
      operations.push(`Added ${bonus_credits} bonus credits`);
    }

    // Force monthly refresh if requested
    if (force_refresh) {
      const monthlyCredits = member.is_paid
        ? parseInt(process.env.MONTHLY_CREDITS_PAID, 10) || 100
        : parseInt(process.env.MONTHLY_CREDITS_FREE, 10) || 10;
      
      const currentBalance = (member.credits_balance || 0) + (bonus_credits || 0);
      const newBalance = currentBalance + monthlyCredits;

      await pool.query(`
        UPDATE member_credits 
        SET credits_balance = $1, last_refreshed_at = NOW(), updated_at = NOW()
        WHERE member_id = $2
      `, [newBalance, member.id]);

      await pool.query(`
        INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        member.id,
        monthlyCredits,
        'admin_refresh',
        newBalance,
        `Manual monthly refresh by admin ${req.adminUser.email}`
      ]);

      totalCreditsAdded += monthlyCredits;
      operations.push(`Added ${monthlyCredits} monthly refresh credits`);
    }

    // Get updated balance
    const updatedResult = await pool.query(`
      SELECT credits_balance FROM member_credits WHERE member_id = $1
    `, [member.id]);

    const finalBalance = updatedResult.rows[0]?.credits_balance || 0;

    console.log(`Admin ${req.adminUser.email} performed credit operations for ${member.email}: ${operations.join(', ')}`);

    res.json({
      success: true,
      member: {
        circle_member_id,
        email: member.email,
        name: member.name,
        is_paid: member.is_paid
      },
      credits: {
        previous_balance: member.credits_balance || 0,
        credits_added: totalCreditsAdded,
        current_balance: finalBalance
      },
      operations,
      admin_user: req.adminUser.email
    });

  } catch (error) {
    console.error('Manual credit refresh error:', error.message);
    res.status(500).json({
      error: 'Failed to refresh credits',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});