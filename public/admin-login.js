const form = document.querySelector('#admin-login-form');
const message = document.querySelector('#login-message');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const response = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: document.querySelector('#admin-email').value.trim(),
      password: document.querySelector('#admin-password').value,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    message.textContent = result.error || 'No fue posible iniciar sesión.';
    message.className = 'message error';
    return;
  }
  window.location.assign('/admin');
});
