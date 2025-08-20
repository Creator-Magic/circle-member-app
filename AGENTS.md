# Circle Member App - Development Documentation

## Project Overview

This is a secure embedded authentication app for Circle.so communities that automatically authenticates members using Circle's Headless API. The app is designed with security-first principles and can only be accessed when embedded within a Circle community.

**Requirements**: Circle Business Plan or higher for API access (both Headless Auth API and Admin API)

## Architecture

### Tech Stack
- **Backend**: Node.js + Express
- **Database**: PostgreSQL 15 with connection pooling
- **Frontend**: Vanilla JavaScript (no framework dependencies)
- **Authentication**: Circle Headless Auth API
- **Security**: CORS, iframe detection, referrer validation
- **Deployment**: Docker Compose with multi-service setup

### Key Components

1. **Server (server.js)**
   - Express server with CORS protection
   - Security middleware for iframe detection
   - Headless Auth API integration
   - Dynamic configuration endpoint

2. **Database Layer (PostgreSQL)**
   - Member data synchronization and storage
   - Credit system with automatic monthly refresh
   - Action logging and audit trails
   - Optimized queries with proper indexing

3. **Client (public/index.html)**
   - PostMessage listener for Circle data
   - Multiple authentication fallbacks
   - Security-aware UI changes
   - Token storage in sessionStorage

4. **Embed Template (circle-embed.html)**
   - Circle member data extraction (10+ methods)
   - PostMessage communication
   - MutationObserver for dynamic content

## Authentication & Database Flow

```mermaid
graph TD
    A[Circle Page Loads] --> B[window.circleUser Detected]
    B --> C[PostMessage to Iframe]
    C --> D[Iframe Receives Member Data]
    D --> E[Server Auth with Email]
    E --> F[Circle Headless API]
    F --> G[JWT Token Received]
    G --> H[Database Upsert Member]
    H --> I[Credit System Check]
    I --> J{New User?}
    J -->|Yes| K[Grant Initial Credits]
    J -->|No| L{Monthly Refresh Due?}
    L -->|Yes| M[Add Monthly Credits]
    L -->|No| N[Use Existing Credits]
    K --> O[Return Enhanced Member Data]
    M --> O
    N --> O
    O --> P[Member Info + Credits Displayed]
```

## Security Implementation

### 1. Environment Variables
All configuration is externalized to `.env` (copy from `.env.example`):
- `CIRCLE_API_TOKEN` - Headless Auth token (NOT regular API token) - Requires Business Plan
- `CIRCLE_ADMIN_API_TOKEN` - Admin API token for tag management - Requires Business Plan
- `CIRCLE_COMMUNITY_DOMAIN` - Your Circle domain (e.g., your-community.circle.so)
- `APP_DOMAIN` - Where this app is hosted (e.g., your-app.example.com)
- `ALLOWED_ORIGINS` - Comma-separated list of allowed origins
- `REQUIRE_IFRAME` - Enforce iframe embedding
- `DISABLE_EMAIL_ONLY_AUTH` - Disable insecure email-only auth
- `PAID_MEMBER_TAGS` - Comma-separated tags indicating paid membership
- `DATABASE_URL` - PostgreSQL connection string
- `INITIAL_CREDITS_FREE` - Credits granted to new free members
- `INITIAL_CREDITS_PAID` - Credits granted to new paid members
- `MONTHLY_CREDITS_FREE` - Monthly credit refresh for free members
- `MONTHLY_CREDITS_PAID` - Monthly credit refresh for paid members

### 2. Security Layers

#### CORS Protection
```javascript
app.use(cors({
  origin: function(origin, callback) {
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('Not allowed by CORS'));
    }
    return callback(null, true);
  },
  credentials: true
}));
```

#### Iframe Detection
```javascript
const isInIframe = window.parent !== window;
if (appConfig.requireIframe && !isInIframe) {
  // Block direct access
}
```

#### Referrer Validation
```javascript
if (!referer || !referer.includes(allowedDomain)) {
  return res.status(403).json({ error: 'Forbidden' });
}
```

## Member Data Extraction Methods

The app tries 10+ methods to extract Circle member data:

1. **window.circleUser** (official, highest priority)
2. **window.Circle.member** (legacy)
3. **window.circleData.member** (alternative)
4. **Template variables** (`{{member.email}}`)
5. **localStorage/sessionStorage** (7+ keys checked)
6. **Meta tags** (circle:member:email, etc.)
7. **DOM attributes** (data-member-email, etc.)
8. **Body/HTML datasets**
9. **JWT cookie decoding**
10. **React DevTools detection**

## Development Workflow

### Local Development

1. Copy `.env.example` to `.env` and configure for development:
```bash
cp .env.example .env
```

Edit `.env` with development settings:
```env
CIRCLE_API_TOKEN=your_headless_auth_token
CIRCLE_ADMIN_API_TOKEN=your_admin_api_token
CIRCLE_COMMUNITY_DOMAIN=localhost
APP_DOMAIN=localhost:8080
ALLOWED_ORIGINS=http://localhost:8080,http://localhost:3000
REQUIRE_IFRAME=false
DISABLE_EMAIL_ONLY_AUTH=false
PAID_MEMBER_TAGS=paid,premium,subscriber,member,vip,pro

# Database configuration
POSTGRES_DB=circle_app
POSTGRES_USER=circle_user
POSTGRES_PASSWORD=secure_dev_password
DATABASE_URL=postgres://circle_user:secure_dev_password@localhost:5432/circle_app

# Credit system
INITIAL_CREDITS_FREE=10
INITIAL_CREDITS_PAID=100
MONTHLY_CREDITS_FREE=10
MONTHLY_CREDITS_PAID=100

NODE_ENV=development
PORT=8080
```

2. Start with Docker Compose (recommended):
```bash
docker compose up -d
```

3. Initialize database schema:
```bash
docker cp database/schema.sql $(docker compose ps -q db):/schema.sql
docker compose exec db psql -U circle_user -d circle_app -f /schema.sql
```

4. Access at `http://localhost:8080`

### Manual Setup (without Docker)

1. Start PostgreSQL locally and create database:
```bash
createdb circle_app
psql circle_app < database/schema.sql
```

2. Run the Node.js app:
```bash
npm install
npm start
```

### Testing in Circle

1. Deploy app to a public URL
2. Update `.env` with production settings
3. Embed using `circle-embed.html` template
4. Test in a Circle post with custom HTML

## Common Issues & Solutions

### Issue: 404 on Member Endpoints
**Problem**: Circle's `/community_members/{id}` endpoint returns 404
**Solution**: App now tries multiple endpoints (`/me`, `/profile`) with graceful fallback

### Issue: PostMessage Origin Mismatch
**Problem**: "does not match recipient window's origin" error
**Solution**: Dynamic origin detection from iframe src

### Issue: Template Variables Not Processing
**Problem**: `{{member.email}}` appears literally
**Solution**: Multiple fallback methods including postMessage and form authentication

### Issue: CORS Blocking Requests
**Problem**: "Not allowed by CORS" errors
**Solution**: Add domain to `ALLOWED_ORIGINS` in `.env`

## Database Schema

### Core Tables

1. **members**: Core member data synchronized from Circle
   - `circle_member_id` (unique) - Links to Circle's member ID
   - `email`, `name`, `avatar_url` - Basic profile info
   - `is_paid`, `tags` - Membership status and categorization
   - `first_seen_at`, `last_seen_at` - Tracking timestamps

2. **member_credits**: Credit system tracking
   - `member_id` (FK) - References members table
   - `credits_balance` - Current available credits
   - `last_refreshed_at` - When credits were last replenished

3. **app_actions**: Action audit log
   - `member_id` (FK) - Who performed the action
   - `action_type` - Type of action (e.g., 'generate_image')
   - `credits_cost` - How many credits were spent
   - `metadata` (JSONB) - Action-specific data

4. **credit_history**: Complete audit trail
   - Tracks all credit balance changes
   - Links to actions that consumed credits
   - Provides transparency and debugging capability

### Database Features

- **Automatic timestamps**: All tables have `created_at`/`updated_at`
- **JSONB support**: Flexible metadata storage with efficient querying
- **Foreign key constraints**: Data integrity protection
- **Indexes**: Optimized for common query patterns
- **Triggers**: Automatic credit history logging
- **Views**: Convenient `member_summary` view with credit info

## API Integration

### Circle Headless Auth API (Business Plan Required)

**Endpoint**: `POST https://app.circle.so/api/v1/headless/auth_token`

**Headers**:
```javascript
{
  'Authorization': `Bearer ${CIRCLE_API_TOKEN}`,
  'Content-Type': 'application/json'
}
```

**Body** (one of):
```javascript
{ "email": "user@example.com" }
{ "community_member_id": "123456" }
{ "sso_id": "google-oauth2|12345" }
```

**Response**:
```javascript
{
  "access_token": "JWT_TOKEN",
  "refresh_token": "REFRESH_TOKEN",
  "access_token_expires_at": "2025-01-01T00:00:00Z",
  "community_member_id": 123456
}
```

### Circle Admin API (Business Plan Required)

**Endpoint**: `DELETE https://app.circle.so/api/admin/v2/tagged_members`

**Purpose**: Automatically removes numeric purchase tags after processing

**Headers**:
```javascript
{
  'Authorization': `Bearer ${CIRCLE_ADMIN_API_TOKEN}`,
  'Content-Type': 'application/json'
}
```

**Query Parameters**:
```javascript
{
  "user_email": "user@example.com",
  "member_tag_id": 12345
}
```

## API Endpoints

### Authentication Endpoints
- `GET /api/config` - Client configuration
- `POST /api/auth` - Member authentication with database sync
- `POST /api/auth/cookies` - Cookie-based authentication
- `GET /api/member/check` - Session validation

### Credit System Endpoints
- `GET /api/credits/:circle_member_id` - Get credit balance
- `POST /api/credits/spend` - Consume credits for actions
- `GET /api/credits/:circle_member_id/history` - Credit transaction history
- `GET /api/actions/:circle_member_id` - Member's action history

### Credit Usage Example
```javascript
// Spend 5 credits for image generation
const response = await fetch('/api/credits/spend', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    circle_member_id: member.id,
    action_type: 'generate_image',
    credits_cost: 5,
    metadata: {
      prompt: 'A sunset over mountains',
      model: 'dall-e-3'
    }
  })
});

if (response.status === 402) {
  console.log('Insufficient credits');
}
```

### Purchase Tag Processing

The app automatically detects and processes numeric tags:
- Tags like "$10", "$50", "$100" or "10", "50", "100"
- Credits are immediately added to member balance
- Tags are automatically removed via Admin API
- All transactions are logged in database
- Requires `CIRCLE_ADMIN_API_TOKEN` to be configured

## Testing Checklist

### Security Tests
- [ ] Direct access blocked when `REQUIRE_IFRAME=true`
- [ ] PostMessage only accepts from `ALLOWED_ORIGINS`
- [ ] Email-only auth disabled when `DISABLE_EMAIL_ONLY_AUTH=true`
- [ ] Auto-authentication works with `window.circleUser`
- [ ] Fallback to form only in development mode
- [ ] Tokens stored in sessionStorage
- [ ] Member info displays correctly
- [ ] CORS blocks unauthorized origins
- [ ] Referrer validation works

### Database Tests
- [ ] Member data syncs correctly on authentication
- [ ] New users receive initial credits
- [ ] Monthly credit refresh works after 30 days
- [ ] Credit spending decreases balance correctly
- [ ] Action logging captures all required metadata
- [ ] Credit history provides complete audit trail
- [ ] Database gracefully handles connection failures

### Credit System Tests
- [ ] Insufficient credit errors return 402 status
- [ ] Paid vs free member credits are handled correctly
- [ ] Transaction rollbacks work on errors
- [ ] Credit balance queries are accurate
- [ ] Monthly refresh doesn't happen prematurely

## Performance Optimizations

1. **Lazy Config Loading**: Config fetched only once on init
2. **Token Caching**: Access tokens stored in sessionStorage
3. **Retry Logic**: Multiple attempts for member data extraction
4. **MutationObserver Cleanup**: Auto-disconnects after 10 seconds

## Monitoring & Debugging

### Server Logs
```javascript
console.log('=== AUTH REQUEST START ===');
console.log('Security check - Referer:', referer);
console.log('Circle API auth response:', authResponse.data);
```

### Client Logs
```javascript
console.log('=== POSTMESSAGE RECEIVED ===');
console.log('✅ Found window.circleUser object');
console.log('Authentication successful!');
```

### Debug Mode
Check browser console for detailed logs:
- Member data extraction attempts
- PostMessage communication
- Authentication flow
- Security checks

## Future Enhancements

1. **Token Refresh**: Implement automatic token refresh before expiration
2. **WebSocket Support**: Real-time member updates
3. **Analytics Integration**: Track authentication success rates
4. **Multi-Community Support**: Handle multiple Circle communities
5. **SSO Integration**: Support for external SSO providers
6. **Rate Limiting**: Add rate limiting for API calls
7. **Caching Layer**: Redis for token caching
8. **Health Checks**: Monitoring endpoints

## Security Audit Checklist

- [x] All sensitive data in environment variables
- [x] CORS configured with specific origins
- [x] Iframe detection implemented
- [x] Referrer validation active
- [x] Email-only auth can be disabled
- [x] PostMessage origin validation
- [x] HTTPS enforced in production
- [x] No hardcoded secrets
- [x] Security headers configured
- [x] Input validation on all endpoints
- [x] Configurable paid member tags
- [x] PostgreSQL database integration
- [x] Automated credit system
- [x] Transaction-safe credit operations
- [x] Complete audit logging
- [x] Admin API token for secure tag management
- [x] Automatic purchase tag processing and removal

## Commands Reference

```bash
# Development with Docker (Recommended)
docker compose up -d              # Start all services
docker compose logs -f            # View logs
docker compose down               # Stop all services

# Database operations
docker compose exec db psql -U circle_user -d circle_app  # Connect to DB
docker cp database/schema.sql $(docker compose ps -q db):/schema.sql  # Copy schema

# Manual development
npm start                         # Start app only (requires local PostgreSQL)
npm run dev                       # Start with nodemon

# Production
NODE_ENV=production docker compose up -d

# Testing
npm test                          # Run tests (if configured)
npm run lint                      # Lint code (if configured)
```

## Contact & Support

For development questions or issues, check:
1. Browser console for client-side errors
2. Server logs for backend issues
3. Circle API documentation
4. GitHub issues for known problems