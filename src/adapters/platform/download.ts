export function downloadFile(data: Uint8Array, filename: string, mime = 'application/pdf'): void {
  const safeName =
    filename.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'converted.pdf';
  const url = URL.createObjectURL(new Blob([data.slice().buffer], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
