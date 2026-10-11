// Friction audit (reviewer r3-ux). Each task is written as the steps a person takes, counted in taps
// (typing, and pasting with the system menu, are listed but a paste menu counts as two taps). The counts
// are checked against the code through "facts": if a shortcut is added later, a fact test fails and says
// that the count and the advice have to be looked at again. Nothing here fails today.
import { describe, expect, it } from 'vitest';
import { read } from './helpers.js';

const tap = (text) => ({ k: 'tap', text });
const type = (text) => ({ k: 'type', text });
const os = (text) => ({ k: 'os', text }); // a tap inside a system dialog or keyboard bar
const auto = (text) => ({ k: 'auto', text }); // done by the app

// What it takes, from the first screen. "fresh" means a new visitor on a phone, "in" means signed in.
export const FLOWS = {
  'sign in with email, new account': {
    steps: [tap('Continue with email'), tap('email box'), type('email'), tap('Continue'), os('code from the keyboard bar'), auto('sends the code when 6 digits are in'), tap('name box'), type('name'), tap('Start')],
    taps: 6,
    shorter: ['focus the email box when the screen opens (-1)', 'focus the name box (-1)', 'put the email box on the welcome screen itself (-1)']
  },
  'sign in with email, returning account': {
    steps: [tap('Continue with email'), tap('email box'), type('email'), tap('Continue'), os('code from the keyboard bar'), auto('sends the code when 6 digits are in')],
    taps: 4,
    shorter: ['focus the email box (-1)', 'remember the last email on this device and offer it as one tap (-2 with the typing)']
  },
  'publish a file, signed in': {
    steps: [tap('Files tab'), tap('Add file'), tap('Choose a file'), os('pick the file'), tap('Publish'), auto('link copied when the browser allows')],
    taps: 5,
    shorter: ['open the system file picker straight from the + button (-1)', 'a Publish shortcut from the system Share menu (share target) (-3)']
  },
  'publish a file, new visitor with Quick start': {
    steps: [tap('Quick start'), tap('name box'), type('name'), tap('Start'), tap('Files tab'), tap('Add file'), tap('Choose a file'), os('pick the file'), tap('Publish')],
    taps: 8,
    shorter: ['land on Files after the first sign in when the person came from "Add file" (-1)', 'focus the name box (-1)']
  },
  'share a file link': {
    steps: [auto('the link is already on the clipboard after Publish'), tap('Share (phones only)')],
    taps: 1,
    shorter: ['already short; on iPhone the automatic copy is refused because it runs seconds after the tap, so the Share button is the real path']
  },
  'share a file later': {
    steps: [tap('Files tab'), tap('the file'), tap('Share')],
    taps: 3,
    shorter: ['a share button on the row (-1)']
  },
  'open a shared link as a visitor (link has the password)': {
    steps: [tap('the link'), auto('checks and unlocks'), tap('Open file')],
    taps: 2,
    shorter: ['none worth the risk; the answer and the button are on one screen']
  },
  'open a shared link as a visitor (link without the password)': {
    steps: [tap('the link'), tap('Open file'), tap('password box'), os('paste (long press, Paste)'), os('paste'), tap('Open file')],
    taps: 6,
    shorter: ['focus the password box as soon as it appears (-1)', 'offer "Paste" as a button (-1)']
  },
  'check a document as an official, from a link': {
    steps: [tap('the link'), auto('the answer is at the top of the page')],
    taps: 1,
    shorter: ['none; this is the short path, say so on the Verify screen']
  },
  'check a document as an official, on the Verify tab': {
    steps: [tap('Verify tab'), tap('input box'), os('paste (long press, Paste)'), os('paste'), tap('Check')],
    taps: 5,
    shorter: ['focus the box on arrival (-1)', 'a "Paste and check" button that reads the clipboard (-3)', 'check by itself when a whole link is pasted (-1)']
  },
  'send a chat message, signed in': {
    steps: [tap('the chat'), tap('message box'), type('message'), tap('Send')],
    taps: 3,
    shorter: ['none: opening the keyboard on arrival would hide the messages']
  },
  'send a chat message, signed out visitor': {
    steps: [tap('the chat'), tap('Sign in to write'), tap('Continue with email'), tap('email box'), type('email'), tap('Continue'), os('code'), tap('message box'), type('message'), tap('Send')],
    taps: 8,
    shorter: ['the sign in comes back to the same chat (it does)', 'focus the message box after coming back (-1)']
  },
  'update a file': {
    steps: [tap('Files tab'), tap('the file'), tap('Manage'), tap('Update file'), tap('Choose a file'), os('pick the file'), tap('Publish version')],
    taps: 7,
    shorter: ['put Update file on the file page for the owner instead of behind Manage (-1)', 'open the picker straight away (-1)']
  },
  'withdraw a file': {
    steps: [tap('Files tab'), tap('the file'), tap('Manage'), tap('Withdraw file'), tap('reason box'), type('reason'), tap('"I understand" tick'), tap('Withdraw file')],
    taps: 7,
    shorter: ['drop the tick: the red button after the warning is already the confirmation (-1)', 'focus the reason box (-1)']
  },
  'switch device, Easy account': {
    steps: [tap('Continue with email'), tap('email box'), type('email'), tap('Continue'), os('code from the keyboard bar'), auto('the key and the file passwords come back from the account')],
    taps: 4,
    shorter: ['same as sign in']
  },
  'switch device, Strict account': {
    steps: [tap('Continue with email'), tap('email box'), type('email'), tap('Continue'), os('code'), tap('name box'), type('name'), tap('Start')],
    taps: 6,
    shorter: ['by design this device is a new identity; files stay with the old device']
  },
  'switch device, Quick start': {
    steps: [],
    taps: Infinity,
    shorter: ['impossible: the key cannot leave the browser; say so before someone depends on it']
  }
};

describe('the step counts', () => {
  for (const [name, flow] of Object.entries(FLOWS)) {
    it(`${name}: ${Number.isFinite(flow.taps) ? flow.taps + ' taps' : 'cannot be done'}`, () => {
      const counted = flow.steps.filter((s) => s.k === 'tap' || s.k === 'os').length;
      if (Number.isFinite(flow.taps)) {
        // an os step counts as a tap, but the two-step paste menu counts once for each press
        expect(counted).toBe(flow.taps);
      } else {
        expect(flow.steps.length).toBe(0);
      }
    });
  }
});

describe('facts the counts rely on (when one of these changes, redo the counts)', () => {
  const signin = read('src/pages/SignInPage.jsx');

  it('the code step puts the cursor in the first box, offers the code from the keyboard bar, and sends at six digits', () => {
    expect(signin).toMatch(/<OtpInput[^>]*autoFocus/);
    expect(read('src/components/OtpInput.jsx')).toMatch(/one-time-code/);
    expect(signin).toMatch(/onComplete=\{submit\}/);
  });

  it('GAP: the email box and the name box are not focused when their step opens', () => {
    // The route change moves focus to the heading, so each step costs one extra tap on the box.
    const emailStep = signin.slice(signin.indexOf('function EmailStep'), signin.indexOf('function CodeStep'));
    const nameStep = signin.slice(signin.indexOf('function NameStep'), signin.indexOf('// Sign in with an email'));
    expect(emailStep).not.toMatch(/autoFocus|\.focus\(/);
    expect(nameStep).not.toMatch(/autoFocus|\.focus\(/);
  });

  it('GAP: the email is only kept in memory, not on the device', () => {
    expect(signin).not.toMatch(/localStorage|sessionStorage/);
  });

  it('the welcome screen has no email box: email costs a screen', () => {
    expect(read('src/pages/WelcomePage.jsx')).not.toMatch(/type="email"/);
  });

  it('Publish copies the link by itself, then Share or Copy link are optional', () => {
    expect(read('src/components/files/addFlow.js')).toMatch(/copy\(link\)/);
    expect(read('src/components/files/AddFileSheet.jsx')).toMatch(/done\.copied/);
  });

  it('GAP: the copy happens after the upload, seconds after the tap, so a browser that wants a fresh tap refuses it', () => {
    // addFlow awaits runPublish and the password save before it calls copy().
    const flow = read('src/components/files/addFlow.js');
    expect(flow.indexOf('await runPublish')).toBeLessThan(flow.indexOf('copy(link)'));
  });

  it('GAP: the Add file sheet does not open the file picker by itself', () => {
    expect(read('src/components/files/AddFileSheet.jsx')).not.toMatch(/\.click\(\)|showOpenFilePicker/);
  });

  it('a link with #k= is read, removed from the address bar and used to unlock the file without a prompt', () => {
    const page = read('src/pages/DocumentPage.jsx');
    expect(page).toMatch(/parseFragment/);
    expect(page).toMatch(/dropFragment\(\)/);
    expect(page).toMatch(/initialPassword/);
  });

  it('GAP: the one line password prompt is not focused when it appears', () => {
    expect(read('src/components/doc/PasswordLine.jsx')).not.toMatch(/autoFocus|\.focus\(/);
  });

  it('GAP: the Verify box is not focused, has no paste button, and does not check by itself', () => {
    const quick = read('src/components/verify/QuickCheck.jsx');
    expect(quick).not.toMatch(/autoFocus/);
    expect(quick).not.toMatch(/clipboard\.readText/);
    expect(quick).not.toMatch(/onPaste/);
  });

  it('a link to a file page already shows the answer: no second screen for an official', () => {
    expect(read('src/components/doc/FileView.jsx')).toMatch(/<VerifySummary[^>]*compact/);
  });

  it('the owner reaches Update and Withdraw only through the Manage menu', () => {
    const manage = read('src/components/doc/ManageSheet.jsx');
    expect(manage).toMatch(/title="Update file"/);
    expect(manage).toMatch(/title="Withdraw file"/);
    expect(read('src/components/doc/FileView.jsx')).not.toMatch(/Update file|Withdraw file/);
  });

  it('withdrawing asks three times: the menu entry, a tick, and the button', () => {
    const revoke = read('src/components/doc/RevokePanel.jsx');
    expect(revoke).toMatch(/type="checkbox"/);
    expect(revoke).toMatch(/variant="danger"/);
    expect(revoke).toMatch(/Withdrawing is permanent and public/);
  });

  it('an Easy account that signs in on a new device gets the key back without the name step', () => {
    const store = read('src/lib/sessionStore.js');
    expect(store).toMatch(/api\.getMyKey\(\)/);
    expect(store).toMatch(/status: 'ready', mode: 'account'/);
  });

  it('a Quick start key never leaves the browser, so there is no way to move it', () => {
    const device = read('src/lib/deviceKey.js');
    expect(device).toMatch(/extractable: false|non extractable|not extractable/i);
  });

  it('the sign in sheet sends people back to the page they came from', () => {
    expect(read('src/components/AuthPrompt.jsx')).toMatch(/next=' \+ encodeURIComponent\(next\)/);
    expect(read('src/lib/format.js')).toMatch(/export function safeNextPath/);
  });

  it('sheets put the first useful control in focus: the name box, the file chooser, or Cancel for a risky step', () => {
    expect(read('src/components/chat/NewChatSheet.jsx')).toMatch(/data-autofocus/);
    expect(read('src/pages/MePage.jsx')).toMatch(/data-autofocus="true"/);
    expect(read('src/components/Sheet.jsx')).toMatch(/\[data-autofocus\]/);
  });
});
