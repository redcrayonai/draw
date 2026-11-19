import { initBoardLoading, failBoardLoading } from './board-loading';

// Paint loading feedback before downloading the editor and restoring auth.
initBoardLoading();
void import('./main').catch(error => {
  console.error('Board startup failed:', error);
  failBoardLoading();
});

const issueDialog = document.querySelector<HTMLDialogElement>('#issue-dialog')!;
const issueForm = issueDialog.querySelector('form')!;
const message = issueForm.querySelector('textarea')!;
document.getElementById('report-issue')!.onclick = () => issueDialog.showModal();
issueDialog.onkeydown = event => event.stopPropagation();
issueForm.querySelector<HTMLButtonElement>('[type="button"]')!.onclick = () => issueDialog.close();
issueForm.onsubmit = event => {
  // Leave room in the GitHub URL for the form fields and the sign-in redirect.
  const encoded = new URLSearchParams({ message: message.value.replace(/\n/g, '\r\n') });
  if (!message.value.trim()) message.setCustomValidity('Enter a message.');
  else if (encoded.toString().length > 3800) {
    message.setCustomValidity('Shorten your message to open the GitHub form. You can add more detail there.');
  }
  if (!message.validity.valid) {
    event.preventDefault();
    message.reportValidity();
    return;
  }
  const template = issueForm.querySelector<HTMLSelectElement>('[name="template"]')!;
  message.name = template.value === 'bug_report.yml' ? 'behavior' : 'problem';
};
message.oninput = () => message.setCustomValidity('');
