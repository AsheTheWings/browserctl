const form = document.getElementById('password-sign-in');
const field = document.getElementById('password');
const error = document.getElementById('sign-in-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = field.value;
  const button = form.querySelector('button');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      error.textContent = (await response.json()).error;
      return;
    }
    location.replace('/dashboard/');
  } catch {
    error.textContent = 'Could not reach the dashboard. Try again.';
  } finally {
    button.disabled = false;
  }
});
