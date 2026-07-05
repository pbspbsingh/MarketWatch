export function applyImageRevision(root: ParentNode, revision: number) {
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    const sourceUrl = new URL(image.src, window.location.href);
    if (!sourceUrl.pathname.startsWith("/api/daily-notes/images/")) continue;
    sourceUrl.searchParams.set("revision", String(revision));
    image.src = sourceUrl.toString();
  }
}
