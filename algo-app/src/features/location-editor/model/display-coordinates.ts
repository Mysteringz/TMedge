/** Show bottom-left metre coordinates while keeping persisted top-left centimetres unchanged. */
export function bottomYMetres(yCm: number, roomHeightCm: number, objectHeightCm = 0): number {
  return Number(((roomHeightCm - yCm - objectHeightCm) / 100).toFixed(10));
}

/** Preserve an exact canonical value on no-op blur, including inherited fractional geometry. */
export function canonicalY(displayMetres: number, roomHeightCm: number, previousY?: number, objectHeightCm = 0): number {
  if (previousY !== undefined && displayMetres === bottomYMetres(previousY, roomHeightCm, objectHeightCm)) return previousY;
  return Number((roomHeightCm - displayMetres * 100 - objectHeightCm).toFixed(6));
}
