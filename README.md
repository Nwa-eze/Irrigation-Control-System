# Irrigation Control System

This project is a web application for controlling an irrigation system. It includes a frontend and a backend, and it can be run in a Docker container.

## Prerequisites

- Docker
- Docker Compose

## Getting Started

1. Clone the repository:
   ```
   git clone https://github.com/Nwa-eze/Irrigation-Control-System.git
   ```
2. Navigate to the project directory:
   ```
   cd Irrigation-Control-System
   ```
3. Create a `.env` file and add your Stripe secret key:
   ```
   STRIPE_SECRET_KEY=your_stripe_secret_key
   ```
4. Build and run the application using Docker Compose:
   ```
   docker-compose up --build
   ```
5. Open your browser and navigate to the `API_URL` specified in your `.env` file.

## Database

The application uses a MySQL database. The database is automatically created and seeded when you run the application using Docker Compose.

You can connect to the database using the following credentials:

- Host: `localhost`
- Port: `3306`
- User: `root`
- Password: `password`
- Database: `water distribution`
