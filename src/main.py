import os
import json
import uvicorn
import datetime
import holidays
import itertools
from fastapi import FastAPI


ru_holidays = holidays.RU()

def comma_separated_array(s):
    return [piece.strip() for piece in s.split(',')] if s else []

def is_worktime(t):
    return t.date() not in ru_holidays and t.weekday() < 5 and 11 <= t.hour <= 17

def count_x_workhours_back(a, x):
    for hour in range(x):
        a -= datetime.timedelta(hours=1)
        while not is_worktime(a):
            a -= datetime.timedelta(hours=1)
    return a

def count_x_workhours_forward(a, x):
    for hour in range(x):
        a += datetime.timedelta(hours=1)
        while not is_worktime(a):
            a += datetime.timedelta(hours=1)
    return a

def workhours_between(a, b):
    result = 0
    while a < b:
        result += 1
        a += datetime.timedelta(hours=1)
        while not is_worktime(a):
            a += datetime.timedelta(hours=1)
    return result

def smallest_untaken_integer(numbers):
    if len(numbers):
        for x in range(max(numbers) + 2):
            if x not in numbers:
                return x
    else:
        return 0


# main class
class Task:
    def __init__(self, tsvline):
        fields = tsvline.split('\t')
        self.id = int(fields[0])
        self.blocking_ids = [int(x) for x in comma_separated_array(fields[1])]
        self.skills = comma_separated_array(fields[2])
        self.description = fields[3]
        self.streams = comma_separated_array(fields[4])
        self.sharp_time = datetime.datetime.strptime(fields[5], '%Y-%m-%d %H:%M') if fields[5] else None
        self.deadline = datetime.datetime.strptime(fields[6], '%Y-%m-%d') if fields[6] else None
        if self.deadline is not None and self.deadline.hour == 0:
            self.deadline = self.deadline.replace(hour=17)
        self.days_left = int(fields[7]) if fields[7] else None
        self.estimate = int(fields[8]) if fields[8] else 3
        self.team = comma_separated_array(fields[9])
        self.assignees = comma_separated_array(fields[10])
        self.orderers = comma_separated_array(fields[11])
        self.jira = comma_separated_array(fields[12])
        self.is_done = fields[13] == 'TRUE'
        self.is_target = fields[14] == 'TRUE'
        try:
            self.priority = int(fields[15].strip())
        except:
            self.priority = 10
        self.rank = None
        self.lane = None


app = FastAPI(root_path="/api")

@app.get('/')
def get():
    tasks = []

    # parsing source file
    with open(os.path.join(os.getcwd(), 'tasks.tsv'), 'r') as source:
        for line in source.readlines():
            try:
                task = Task(line)
                if task.description:
                    tasks.append(task)
            except:
                # print(line)
                # traceback.print_exc()
                pass

    # reversing blocked-blocker relation
    for task in tasks:
        task.blocked_ids = [t.id for t in tasks if task.id in t.blocking_ids]

    # ranking
    changes_found = True
    while changes_found:
        changes_found = False
        for task in tasks:
            task.is_doable = all([t.is_done for t in tasks if t.id in task.blocking_ids]) and not task.is_done
            new_rank = max([t.rank for t in tasks if t.id in task.blocking_ids and t.rank is not None] + [0]) + 1
            if task.rank != new_rank:
                changes_found = True
                task.rank = new_rank

    ranks = sorted(list(set([task.rank for task in tasks])), reverse=True)

    # calculating deadlines and startlines where applicable
    for rank in ranks:
        rankset = [t for t in tasks if t.rank == rank]
        for task in rankset:
            deadlines = [count_x_workhours_back(t.startline, 2) for t in tasks if
                         task.id in t.blocking_ids and t.startline is not None]
            if task.deadline:
                deadlines += [task.deadline]
            if deadlines:
                task.deadline = min(deadlines)
                task.startline = count_x_workhours_back(task.deadline, task.estimate)
            else:
                task.deadline = None
                task.startline = None

    # stringifying datetimes for json
    for task in tasks:
        if task.deadline:
            task.deadline = task.deadline.isoformat()
        if task.startline:
            task.startline = task.startline.isoformat()
        if task.sharp_time:
            task.sharp_time = task.sharp_time.isoformat()

    return f'[{",\n".join([json.dumps(vars(task)) for task in tasks])}]'


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=11111)
