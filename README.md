# 🗄️ Hotelogx Connect Backend API

Production-grade **Express.js + Prisma ORM + MySQL** backend API service for **Hotelogx Connect**.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Database**: MySQL
- **ORM**: Prisma ORM (v6)
- **Authentication**: JWT (JSON Web Tokens) & `bcryptjs` for password hashing
- **Environment Management**: `dotenv`
- **Development Tool**: Nodemon

---

## 🚀 Setup Instructions

### 1. Configure Environment Variables (`.env`)
Create or edit `.env` in the `hotel-backend` directory with your MySQL credentials:

```env
DATABASE_URL="mysql://root:password@localhost:3306/hotel_db"
JWT_SECRET="your-super-secret-jwt-key"
PORT=5000
```

### 2. Install Dependencies
```bash
cd hotel-backend
npm install
```

### 3. Generate Prisma Client & Push Database Schema
```bash
# Generate Prisma Client types
npm run prisma:generate

# Push schema directly to MySQL database
npm run prisma:push
```

### 4. Seed Initial Hotel Data (Optional)
Populate the database with sample staff, rooms, tasks, and initial configurations:
```bash
npm run prisma:seed
```

### 5. Start Backend Server
```bash
# Development mode (with auto-restart via Nodemon)
npm run dev

# Production mode
npm run start
```
> Server runs on **`http://localhost:5000`**

---

## 📜 Available NPM Scripts

- `npm run dev`: Starts the server with Nodemon for hot-reloading.
- `npm run start`: Runs the server with standard Node.js.
- `npm run prisma:generate`: Generates updated Prisma Client code.
- `npm run prisma:push`: Applies Prisma schema changes directly to MySQL.
- `npm run prisma:seed`: Seeds initial hotel data into MySQL.
- `npm run prisma:studio`: Opens Prisma Studio GUI in browser (`http://localhost:5555`).

---

## 📡 API Endpoints Reference

### 🏥 Health Check
- `GET /api/health` - Check backend service health status.

### 🔐 Authentication
- `POST /api/auth/login` - Staff & Manager Login.
- `GET /api/auth/me` - Get currently authenticated user details.
- `GET /api/auth/staff` - Get list of all staff members.

### 🛏️ Rooms & Housekeeping
- `GET /api/rooms` - Fetch list of all hotel rooms & current status.
- `GET /api/rooms/:number` - Fetch specific room details.
- `PATCH /api/rooms/:number/status` - Update room cleaning / maintenance status.

### 📋 Tasks & Assignments
- `GET /api/tasks` - List all staff tasks.
- `POST /api/tasks` - Create a new staff task.
- `PATCH /api/tasks/:id/status` - Update task completion status.

### 🛠️ Issues & Maintenance
- `GET /api/issues` - List maintenance issues.
- `POST /api/issues` - Log a new maintenance issue.
- `PATCH /api/issues/:id/status` - Update maintenance issue status.

### 💬 Conversations & Guest Chat
- `GET /api/conversations` - List guest conversations.
- `GET /api/conversations/:id` - Fetch chat history for a conversation.
- `POST /api/conversations/:id/reply` - Send reply message to guest.
- `POST /api/conversations/:id/takeover` - Human takeover from AI assistant.

### 📊 Manager Portal & AI Intelligence
- `GET /api/manager/briefing` - Get daily AI manager briefing.
- `GET /api/manager/activity` - Get real-time system activity log.
- `GET /api/manager/rules` - Get active automation rules.
- `GET /api/manager/knowledge` - Get hotel knowledge base items.

### 🏷️ Upsells Pipeline
- `GET /api/upsells` - List active upsell offers and room upgrades.
- `PATCH /api/upsells/:id/status` - Update upsell deal status.

### 📱 WhatsApp Simulator
- `GET /api/whatsapp/threads` - Get active WhatsApp thread simulations.
- `POST /api/whatsapp/action` - Trigger simulated WhatsApp actions/messages.
