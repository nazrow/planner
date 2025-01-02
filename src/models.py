import uuid
import os
from typing import List, Optional
from pydantic import ValidationError
from sqlmodel import SQLModel, Field, Session, create_engine, select


engine = create_engine(f'postgresql://admin:{os.environ.get("PGADMINPASSWORD")}@localhost/planner', echo=True)


class Contact(SQLModel, table=True):
    username: str = Field(primary_key=True)


class Task(SQLModel, table=True):
    id: Optional[uuid.UUID] = Field(default=uuid.uuid4, primary_key=True)
    title: str
    description: List[str]
    consumers: List[str]
    assignees: List[str]
    route: List[str]
    location: List[str]
    progress: int
    duration_total: int
    duration_atom: int
    prerequisites: List[str]

    def validate(self):
        if len(self.prerequisites):
            with Session(engine) as session:
                for prereq in self.prerequisites:
                    filter = select(Task).where(Task.id == prereq).limit(1)
                    results = session.exec(filter).all()
                    if not results:
                        raise ValidationError
    def save(self):
        with Session(engine) as session:
            session.add(self)
            session.commit()
            session.refresh(self)


SQLModel.metadata.create_all(engine)
