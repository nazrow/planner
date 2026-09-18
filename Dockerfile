FROM mirror.gcr.io/python:3.13-slim

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY migrations/ ./migrations/
COPY src/ ./src/
COPY www/ ./www/

EXPOSE 11111
# The app brings the schema up to date itself on startup (MIGRATE_ON_START).
# Behind nginx, requests arrive from Docker's bridge address rather than
# 127.0.0.1, so uvicorn has to be told to believe X-Forwarded-Proto; otherwise
# any redirect it issues would point at http://. Safe because compose only
# publishes the port on the host's loopback.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "11111", "--proxy-headers", "--forwarded-allow-ips", "*"]
