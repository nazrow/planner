fetch('api').then(function(response) {
  return response.json();
}).then(function(tasks) {
  console.log(tasks);
  tasks.forEach((task) => {
      var node = document.createElement('div');
      node.id = task.id;
      node.style.top = `${task.startline_hours}px`;
      node.style.height = `${task.estimate * 8}px`;
      node.style.left = `${task.lane * 260}px`;
      node.textContent = task.description;
      document.body.appendChild(node);
  });
}).catch(function(err) {
  console.log(err);
});
