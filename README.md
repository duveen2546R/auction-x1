# AuctionXI

AuctionXI is a sophisticated real-time cricket auction platform designed for immersive and strategic team building. It provides a seamless, interactive experience for users to bid on their favorite players, manage budgets, and build their ultimate "Playing 11" squad.

## 🚀 Key Features

-   **Real-time Bidding:** Instantaneous bidding powered by Socket.io, featuring dynamic increments (0.2 for bids under 10, 0.5 for bids 10 and above).
-   **Structured Player Pools:** Auctions are organized into logical sets (Indian Batsmen, Overseas All-Rounders, etc.) for a professional experience.
-   **Integrated Voice Chat:** Communicate with fellow participants in real-time during the heat of the auction.
-   **Strategic Budget Management:** Track your team's spending with automatic budget enforcement and live updates.
-   **Dynamic Timer:** High-intensity bidding with a timer that extends slightly after each bid to ensure everyone has a fair chance.
-   **Squad Building & Validation:** Select your "Playing 11" with built-in rule validation (e.g., minimums for Batsmen, Bowlers, Wicketkeepers, and maximums for Overseas players).
-   **Automated Scoring:** Winner is determined based on an advanced scoring algorithm that considers both player ratings and remaining budget.
-   **State Persistence & Recovery:** PostgreSQL-backed backend ensures that the auction state is saved and can be recovered if needed.

## 🛠️ Technology Stack

### Frontend
-   **React:** Modern UI library for a responsive and dynamic user interface.
-   **Vite:** Fast, next-generation build tool.
-   **Tailwind CSS:** Utility-first CSS framework for rapid and consistent styling.
-   **Socket.io-client:** Real-time bidirectional communication.
-   **React Router:** For seamless single-page navigation.

### Backend
-   **Node.js & Express:** Robust server-side framework.
-   **Socket.io:** Real-time engine for bidding and chat.
-   **PostgreSQL (pg):** Relational database for persistent data storage.
-   **dotenv:** Environment variable management.

## 📂 Project Structure

```text
/
├── backend/            # Express server, Socket.io logic, and DB integration
│   ├── src/            # Application logic, stores, and routes
│   └── db/             # SQL schema and database scripts
├── frontend/           # React frontend
│   ├── src/            # Components, pages, and socket configuration
│   └── public/         # Static assets (images, icons, sound effects)
└── README.md           # Project documentation
```

## ⚙️ Getting Started

### Prerequisites
-   Node.js (v18 or higher recommended)
-   PostgreSQL database (local or cloud-based like Supabase)

### Backend Setup
1.  Navigate to the `backend` directory:
    ```bash
    cd backend
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Configure environment variables by creating a `.env` file based on `.env.example`:
    ```bash
    cp .env.example .env
    ```
4.  Update the `DATABASE_URL` in `.env` with your PostgreSQL connection string.
5.  Initialize the database schema using the SQL provided in `backend/db/schema.sql`.
6.  Start the development server:
    ```bash
    npm run dev
    ```

### Frontend Setup
1.  Navigate to the `frontend` directory:
    ```bash
    cd frontend
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create a `.env` file and set the API URL:
    ```text
    VITE_API_URL=http://localhost:5000
    ```
4.  Start the frontend application:
    ```bash
    npm run dev
    ```

## 📋 Database Schema

The project uses several core tables to manage the auction:
-   `users`: Stores participant information.
-   `rooms`: Manages active auction sessions and hosts.
-   `cricketers`: Contains the master list of players and their ratings.
-   `teams`: Predefined team identities.
-   `room_players`: Maps participants to rooms and their respective budgets/teams.
-   `team_players`: Tracks which players were sold to which team and at what price.
-   `auction_state`: Persists the current state of an ongoing auction for recovery.
-   `playing11`: Stores the final squads submitted by participants for scoring.

---
Created by **Duveen Kumar Reddy R**
