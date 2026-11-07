// The Rust side calls showError() if the daemon cannot be started.
window.showError = (message, help) => {
  const msg = document.getElementById('msg');
  msg.textContent = message;
  msg.className = 'bad';
  if (help) {
    const err = document.getElementById('err');
    err.textContent = help;
    err.hidden = false;
  }
};
