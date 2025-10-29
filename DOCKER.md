# Docker Setup for MDN HTTP Observatory

## Quick Start

1. **Start the services:**
   ```bash
   docker-compose up -d
   ```

2. **Check the logs:**
   ```bash
   docker-compose logs -f
   ```

3. **Access the API:**
   - Open http://localhost:8080/ in your browser
   - Should display: "Welcome to the MDN Observatory!"

## Services

- **PostgreSQL Database** (port 5432)
  - User: `postgres`
  - Password: `observatory`
  - Database: `observatory`
  
- **Observatory API** (port 8080)
  - Automatically runs migrations on startup
  - API available at http://localhost:8080

## Commands

### Start services
```bash
docker-compose up -d
```

### Stop services
```bash
docker-compose down
```

### Stop and remove volumes (fresh start)
```bash
docker-compose down -v
```

### View logs
```bash
docker-compose logs -f observatory
docker-compose logs -f postgres
```

### Rebuild after code changes
```bash
docker-compose up -d --build
```

### Access PostgreSQL directly
```bash
docker-compose exec postgres psql -U postgres -d observatory
```

## Configuration

The database configuration is in `config/config.json`. The Docker setup uses these defaults:
- Host: `postgres` (Docker service name)
- Port: 5432
- Database: `observatory`
- User: `postgres`
- Password: `observatory`

To use different credentials, modify:
1. `docker-compose.yml` - PostgreSQL environment variables
2. `config/config.json` - Database connection settings

## Notes

- Database migrations run automatically when the container starts
- PostgreSQL data persists in a Docker volume named `postgres_data`
- The API waits for PostgreSQL to be healthy before starting
