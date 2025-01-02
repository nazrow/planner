import uvicorn
from fastapi import FastAPI
from sqlmodel import Session, select
from models import Task, engine



app = FastAPI()


@app.post('/')
def upload(payload: Task):
    payload.validate()
    payload.save()
    return payload

@app.get('/')
def download():
    with Session(engine) as session:
        query = select(Task)
        result = session.execute(query).all()
        return result


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=80, reload=True)
