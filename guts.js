fetch('api').then(function(response) {
  return response.json();
}).then(function(data) {
  console.log(data);
  draw(data);
}).catch(function(err) {
  console.log('Fetch Error :-S', err);
});


function draw(data) {
  var heads = data.filter((task) => task.prerequisites.length == 0);
  console.log(heads);
}
