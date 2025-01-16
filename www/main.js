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
            links.push({source: task.id, target: link});
        });
    });
    const simulation = d3.forceSimulation(tasks)
        .force('links', d3.forceLink(links).id((task) => task.id))
        .force('done', () => {
            tasks.forEach(task => {
                if (task.is_done) {
                    if (task.y > 0) {
                        task.y = -10;
                        task.vy -= 0.5;
                    }
                } else {
                    if (task.y < 0) {
                        task.y = 10;
                        task.vy += 0.5;
                    }
                }
            })
        })
        .force('priority', () => {
            tasks.forEach(task => {
                task.vy -= task.priority * 0.07;
            })
        })
        .force('doable', () => {
            tasks.forEach(task => {
                if (!task.is_doable) {
                    task.vy += 0.02;
                }
            })
        })
        .force('deadline', () => {
            tasks.forEach(task => {
                if (!task.is_done) {
                    task.y = (task.days_left > 0) ? task.days_left * 100 : 0;
                    task.vy = 0;
                }
            })
        })
        .force('charge', d3.forceManyBody())
        .force('collide', d3.forceCollide((task) => 2 * Math.max(12, parseFloat(task.node.style.height))));
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
