import uuid
import os
from datetime import datetime
from typing import List, Optional
from pydantic import ValidationError
from sqlalchemy.sql.schema import Column
from sqlmodel import SQLModel, Field, Session, create_engine, select, String, ARRAY


engine = create_engine(f'postgresql://postgres:{os.environ.get("PGADMINPASSWORD")}@localhost/planner', echo=True)


class Task(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    title: str
    description: List[str] = Field(default=[], sa_column=Column(ARRAY(String())))
    consumers: List[str] = Field(default=[], sa_column=Column(ARRAY(String())))
    assignees: List[str] = Field(default=[], sa_column=Column(ARRAY(String())))
    route: List[str] = Field(default=[], sa_column=Column(ARRAY(String())))
    location: List[str] = Field(default=[], sa_column=Column(ARRAY(String())))
    deadline: Optional[datetime]
    progress: int = Field(default=0)
    duration_total: int = Field(default=2)
    duration_atom: int = Field(default=2)
    prerequisites: List[str] = Field(default=[], sa_column=Column(ARRAY(String())))

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
