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
    tasks.forEach((task) => {
        var node = document.createElement('div');
        node.id = task.id;
        node.textContent = task.description;
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
    });
    const simulation = d3.forceSimulation(tasks)
        .force('charge', d3.forceManyBody());
    simulation.stop();
    while (simulation.alpha() >= simulation.alphaMin()) {
        simulation.tick();
        tasks.forEach((task) => {
            task.node.style.top = `${task.y}px`;
            task.node.style.left = `${task.x}px`;
        });
        main.style.marginTop = `${Math.min(tasks.map((task) => parseFloat(task.node.style.top))) * -1}px`;
        main.style.marginBottom = `${Math.max(tasks.map((task) => parseFloat(task.node.style.top))) + 400}px`;
        main.style.marginLeft = `${Math.min(tasks.map((task) => parseFloat(task.node.style.left))) * -1}px`;
        main.style.marginRight = `${Math.max(tasks.map((task) => parseFloat(task.node.style.left))) + 250}px`;
    }
    console.log(tasks[0].node);
    console.log(tasks[0].node.style);
    console.log(tasks[0].node.style.top);
    console.log(tasks[0].node.style.getPropertyValue('top'));
    console.log(tasks.map((task) => parseFloat(task.node.style.top)));
    console.log(Math.min(tasks.map((task) => parseFloat(task.node.style.top))));
    simulation.stop();
}
