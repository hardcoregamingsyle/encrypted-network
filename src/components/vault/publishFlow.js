// Runs one publish and tracks the progress steps. The publish function is passed in so tests can
// replace it. It never throws: the answer says whether it worked.
import { publishNewDocument } from '../../lib/publish.js';
import { advanceSteps, createSteps, failSteps, failedStepId, friendlyError, recoveryHint } from './vaultLogic.js';

// onUpdate(steps, text) is called after every change. Returns
// { ok:true, result, steps } or { ok:false, error, message, hint, failedStep, steps }.
export async function runPublish({ file, label, listed, identity, publish = publishNewDocument, onUpdate }) {
  let steps = createSteps();
  const tell = (text) => {
    if (typeof onUpdate !== 'function') return;
    try {
      onUpdate(steps, text);
    } catch {
      // a broken screen update must not stop the publish
    }
  };
  tell('');
  try {
    const result = await publish({
      file,
      label,
      listed: listed === true,
      identity,
      onStep: (id, text) => {
        steps = advanceSteps(steps, id);
        tell(typeof text === 'string' ? text : '');
      }
    });
    steps = advanceSteps(steps, 'done');
    tell('Published');
    return { ok: true, result, steps };
  } catch (err) {
    steps = failSteps(steps);
    const failedStep = failedStepId(steps);
    tell('');
    return {
      ok: false,
      error: err,
      message: friendlyError(err),
      hint: recoveryHint(failedStep),
      failedStep,
      steps
    };
  }
}
