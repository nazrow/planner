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
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "11111"]
