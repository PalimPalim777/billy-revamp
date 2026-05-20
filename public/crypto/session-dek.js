let sessionDEK = null;

export function setSessionDEK(dek) {
  sessionDEK = dek;
}

export function getSessionDEK() {
  return sessionDEK;
}

export function clearSessionDEK() {
  sessionDEK = null;
}
