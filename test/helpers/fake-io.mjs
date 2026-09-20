// A fake `stdout`/`stderr` (just `.write`, collecting lines) and a fake
// @clack/prompts surface, so command tests never touch a real terminal.
export function createSink() {
  const lines = [];
  return {
    write(chunk) {
      lines.push(String(chunk));
    },
    get text() {
      return lines.join('');
    },
    lines,
  };
}

export const CANCEL = Symbol('cancel');

export function createFakePrompts({ cancelOnCall = null, textAnswers = [], passwordAnswer = '', multiselectAnswer = [] } = {}) {
  let call = 0;
  const answers = [...textAnswers];
  return {
    async text() {
      call += 1;
      if (cancelOnCall === call) {return CANCEL;}
      return answers.length > 0 ? answers.shift() : '';
    },
    async password() {
      call += 1;
      return cancelOnCall === call ? CANCEL : passwordAnswer;
    },
    async multiselect() {
      call += 1;
      return cancelOnCall === call ? CANCEL : multiselectAnswer;
    },
    isCancel(value) {
      return value === CANCEL;
    },
    cancel() {
      // No-op: this fake's `cancel` only needs to exist to satisfy the
      // @clack/prompts-shaped interface — no test asserts it was called.
    },
  };
}
