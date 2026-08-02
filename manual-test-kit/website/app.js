const button = document.querySelector('#demo-button');
const status = document.querySelector('#demo-status');
let clicks = 0;

button.addEventListener('click', () => {
  clicks += 1;
  status.textContent = `已点击 ${clicks} 次`;
});
