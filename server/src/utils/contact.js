function validPhone(value) {
  if (typeof value !== "string" || value.length > 28) return false;
  let digits = 0;
  for (const char of value) {
    if ("0123456789".includes(char)) digits++;
    else if (!"+() .-".includes(char)) return false;
  }
  return digits >= 7 && digits <= 15;
}

module.exports = { validPhone };
