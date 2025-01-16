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

function forceDone(alpha) {
    for (let i = 0, k = alpha * 0.1; i < nodes.length; ++i) {
        if (nodes[i].is_done) {
            if (nodes[i].y > 0) {
                nodes[i].y = -10;
                nodes[i].vy -= 5 * k;
            }
        } else {
            if (nodes[i].y < 0) {
                nodes[i].y = 10;
                nodes[i].vy += 5 * k;
            }
        }
    }
}

function forcePriority(alpha) {
    for (let i = 0, k = alpha * 0.1; i < nodes.length; ++i) {
        nodes[i].vy -= node.priority * k;
    }
}

function forceDoable(alpha) {
    for (let i = 0, k = alpha * 0.1; i < nodes.length; ++i) {
        if (!nodes[i].is_doable) {
            nodes[i].vy += 2 * k;
        }
    }
}


function forceDeadline() {
    for (let i = 0; i < nodes.length; ++i) {
        if (!nodes[i].is_done) {
            nodes[i].y = (nodes[i].days_left > 0) ? nodes[i].days_left : 0;
            nodes[i].vy = 0;
        }
    }
}

function draw(tasks) {
    var links = [];
    tasks.forEach((task) => {
        var node = document.createElement('div');
        node.id = task.id;
        node.textContent = task.description;
        node.style.height = `${task.estimate}em`;
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
        task.blocked_ids.forEach((link) => {
            links.push({"source": task.id, "target": link});
        });
    });
    const simulation = d3.forceSimulation(tasks)
        .force('links', d3.forceLink(links).id((task) => task.id))
        .force('done', forceDone(tasks=tasks))
        .force('priority', forcePriority(tasks=tasks))
        .force('doable', forceDoable(tasks=tasks))
        .force('deadline', forceDeadline(tasks=tasks))
        .force('charge', d3.forceManyBody())
        .force('collide', d3.forceCollide((task) => Math.max(12, parseFloat(task.node.style.height))));
    simulation.stop();
    while (simulation.alpha() >= simulation.alphaMin()) {
        simulation.tick();
    }
    simulation.stop();
    var highest = Math.min(...tasks.map((task) => task.y));
    var leftest = Math.min(...tasks.map((task) => task.x));
    tasks.forEach((task) => {
        task.node.style.top = `${(task.y - highest) * 1.2}px`;
        task.node.style.left = `${(task.x - leftest) * 1.2}px`;
    });
}
