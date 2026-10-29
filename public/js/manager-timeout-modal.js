const timeoutModal = document.querySelector('[data-timeout-modal]');
const timeoutModalOpen = document.querySelector('[data-timeout-modal-open]');

if (timeoutModal && timeoutModalOpen) {
  const closeButtons = timeoutModal.querySelectorAll('[data-timeout-modal-close]');

  const closeModal = () => {
    timeoutModal.hidden = true;
    document.body.classList.remove('modal-open');
  };

  timeoutModalOpen.addEventListener('click', () => {
    timeoutModal.hidden = false;
    document.body.classList.add('modal-open');
    timeoutModal.querySelector('.timeout-modal-close').focus();
  });
  closeButtons.forEach((button) => button.addEventListener('click', closeModal));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !timeoutModal.hidden) closeModal();
  });
}