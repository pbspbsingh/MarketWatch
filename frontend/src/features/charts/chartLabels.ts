const maximumCompanyNameLength = 50;

export function chartCompanyNameLabel(companyName: string) {
  const characters = Array.from(companyName.trim());
  if (characters.length === 0) return undefined;
  if (characters.length <= maximumCompanyNameLength) return characters.join("");
  return `${characters.slice(0, maximumCompanyNameLength - 1).join("")}…`;
}
