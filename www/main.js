import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const today = new Date();
const main = document.getElementById('main');

fetch('api').then(function(response) {
    return response.json();
}).then(function(data) {
    var tasks = JSON.parse(data);
    console.log(tasks);
    draw(tasks);
}).catch(function(err) {
    console.log(err);
});

function nodeWidthHeight(id) {
    var node = document.getElementById(id);
    var style = window.getComputedStyle(node);
    console.log('nodeWidthHeight:', id, node, style.width, style.height);
    return [parseFloat(style.width), parseFloat(style.height)];
}

function collide(tasks) {
    tasks.map((task) => {
        [task.left, task.right] = [task.x - task.width/2, task.x + task.width/2];
        [task.top, task.bottom] = [task.y - task.height/2, task.y + task.height/2];
    });
    var x_intersection = (tasks[1].left <= tasks[0].left <= tasks[1].right) || (tasks[1].left <= tasks[0].right <= tasks[1].right) || ((tasks[0].left <= tasks[1].left) && (tasks[0].right >= tasks[1].right));
    var y_intersection = (tasks[1].top <= tasks[0].top <= tasks[1].bottom) || (tasks[1].top <= tasks[0].bottom <= tasks[1].bottom) || ((tasks[0].top <= tasks[1].top) && (tasks[0].bottom >= tasks[1].bottom));
    console.log('collide:', tasks, x_intersection, y_intersection)
    return x_intersection && y_intersection;
}

function findCollisions(tasks) {
    var collisions = [];
    tasks.forEach(task1 => {
        tasks.forEach(task2 => {
            if (collide([task1, task2])) {
                var collisionFoundInList = false;
                collisions.forEach(collision => {
                    if (collision.includes(task1.id) || collision.includes(task2.id)) {
                        if (!(collision.includes(task1.id))) {
                            collision.push(task1.id);
                        }
                        if (!(collision.includes(task2.id))) {
                            collision.push(task2.id);
                        }
                        collisionFoundInList = true;
                    }
                });
                if (!(collisionFoundInList)) {
                    collisions.push([task1.id, task2.id]);
                }
            }
        });
    });
    console.log('findCollisions:', collisions);
    return collisions;
}

function polarMove(task, radius, angle) {
    console.log('polarMove:pre', task, radius, angle);
    task.x += radius * Math.cos(angle);
    task.y += radius * Math.sin(angle);
    console.log('polarMove:post', task);
}

function solveCollisions(collisions, tasks) {
    collisions.forEach(collision => {
        var colliding_tasks = tasks.filter((task) => collision.includes(task.id));
        console.log('solveCollisions:', collision, colliding_tasks)
        var center_x = colliding_tasks.reduce((partSum, task) => partSum + task.x, 0) / colliding_tasks.length;
        var center_y = colliding_tasks.reduce((partSum, task) => partSum + task.y, 0) / colliding_tasks.length;
        var radius = Math.max(...colliding_tasks.map((task) => Math.hypot(task.x - center_x, task.y - center_y)));
        console.log('solveCollisions:', center_x, center_y, radius);
        var j = 0;
        colliding_tasks.forEach((task) => {
            polarMove(task, radius, 2 * Math.PI / colliding_tasks.length * j);
            j += 1;
        });
    });
}

function draw(tasks) {
    var links = [];
    tasks.forEach((task) => {
        var node = document.createElement('div');
        node.id = task.id;
        node.textContent = task.description;
        node.style.minHeight = `${task.estimate * 10}px`;
        node.classList.add('task');
        if (task.is_done) {
            node.classList.add('done');
        } else if (Date.parse(task.deadline) <= today) {
            node.classList.add('overdue');
        } else if (task.is_doable) {
            node.classList.add('doable');
        }
        if (task.is_target) {
            node.classList.add('target');
        }
        task.node = node;
        main.appendChild(task.node);
        [task.width, task.height] = nodeWidthHeight(task.id);
        task.blocked_ids.forEach((link) => {
            links.push({source: task.id, target: link});
        });
    });
    const simulation = d3.forceSimulation(tasks)
        .force('links', d3.forceLink(links).id((task) => task.id))
        .force('status', () => {
            tasks.forEach(task => {
                if (task.is_done) {
                    task.vy -= 400;
                    task.y -= 100;
                } else {
                    if (task.y < 0) {
                        task.vy += 50;
                    }
                }
            })
        })
        .force('priority', () => {
            tasks.forEach(task => {
                task.vy -= task.priority;
            })
        })
        .force('doable', () => {
            tasks.forEach(task => {
                if (!task.is_doable) {
                    task.vy += 100;
                }
            })
        })
        .force('deadline', () => {
            tasks.forEach(task => {
                if (!task.is_done && task.days_left > 0) {
                    task.y = task.days_left * 240;
                    task.vy = 0;
                }
            })
        })
//        .force('collide', () => {
//            var collisions = findCollisions(tasks);
//            solveCollisions(collisions, tasks);
//        })
//        .force('charge', d3.forceManyBody().strength(-20))
    ;
    simulation.stop();

    const canvas = document.getElementById('canvas');
    canvas.width = Math.max(...tasks.map((task) => task.right));
    canvas.height = Math.max(...tasks.map((task) => task.bottom));
    const ctx = canvas.getContext('2d');

    while (simulation.alpha() >= simulation.alphaMin()) {
        debugger;
        simulation.tick();

        var topOffset = Math.min(...tasks.map((task) => task.top));
        var leftOffset = Math.min(...tasks.map((task) => task.left));
        tasks.forEach((task) => {
            task.y -= topOffset;
            task.top -= topOffset;
            task.bottom -= topOffset;
            task.x -= leftOffset;
            task.left -= leftOffset;
            task.right -= leftOffset;
            task.node.style.top = `${(task.y)}px`;
            task.node.style.left = `${(task.x)}px`;
        });

        links.forEach((link) => {
            var start = tasks.filter((task) => task.id = link.source)[0];
            var end = tasks.filter((task) => task.id = link.target)[0];
            var [start_x, start_y] = [(start.left + start.right) / 2, start.bottom];
            var [end_x, end_y] = [(end.left + end.right) / 2, end.top];
            ctx.beginPath();
            ctx.moveTo(start_x, start_y);
            ctx.bezierCurveTo(start_x, start_y + 50, end_x, end_y - 50, end_x, end_y);
            ctx.stroke();
        })
    }
    simulation.stop();
}
