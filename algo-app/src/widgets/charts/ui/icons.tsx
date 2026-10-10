/**
 * Carbon's own icons (@carbon/icons, Apache-2.0), the ones the Bluegrid
 * telemetry components call for. Inline, like the console's others: the CSP
 * admits no icon font or script from elsewhere.
 */
import type { ReactNode } from 'react';

function Icon({ size = 16, className = '', children }: { size?: number; className?: string; children: ReactNode }) {
  return <svg className={`an-icon ${className}`} viewBox="0 0 32 32" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">{children}</svg>;
}
type Props = { size?: number; className?: string };

export const ArrowUp = (p: Props) => <Icon {...p}><path d="M16 4 6 14 7.41 15.41 15 7.83 15 28 17 28 17 7.83 24.59 15.41 26 14 16 4z" /></Icon>;
export const ArrowDown = (p: Props) => <Icon {...p}><path d="M24.59 16.59 17 24.17 17 4 15 4 15 24.17 7.41 16.59 6 18 16 28 26 18 24.59 16.59z" /></Icon>;
export const TableSplit = (p: Props) => <Icon {...p}><path d="M27,3H5A2,2,0,0,0,3,5V27a2,2,0,0,0,2,2H27a2,2,0,0,0,2-2V5A2,2,0,0,0,27,3Zm0,2V9H5V5ZM17,11H27v7H17Zm-2,7H5V11H15ZM5,20H15v7H5Zm12,7V20H27v7Z" /></Icon>;
export const ChartLine = (p: Props) => <Icon {...p}><path d="M4.67,28l6.39-12,7.3,6.49a2,2,0,0,0,1.7.47,2,2,0,0,0,1.42-1.07L27,10.9,25.18,10,19.69,21l-7.3-6.49A2,2,0,0,0,10.71,14a2,2,0,0,0-1.42,1L4,25V2H2V28a2,2,0,0,0,2,2H30V28Z" /></Icon>;
export const Renew = (p: Props) => <Icon {...p}><path d="M12,10H6.78A11,11,0,0,1,27,16h2A13,13,0,0,0,6,7.68V4H4v8h8Z" /><path d="M20,22h5.22A11,11,0,0,1,5,16H3a13,13,0,0,0,23,8.32V28h2V20H20Z" /></Icon>;
export const CheckmarkFilled = (p: Props) => <Icon {...p}><path d="M16,2A14,14,0,1,0,30,16,14,14,0,0,0,16,2ZM14,21.5908l-5-5L10.5906,15,14,18.4092,21.41,11l1.5957,1.5859Z" /></Icon>;
/** The mark inside stays dark: yellow alone is under 3:1 on some grounds, so the glyph carries it. */
export const WarningFilled = (p: Props) => (
  <Icon {...p}>
    <path d="M16,2C8.3,2,2,8.3,2,16s6.3,14,14,14s14-6.3,14-14C30,8.3,23.7,2,16,2z M14.9,8h2.2v11h-2.2V8z M16,25 c-0.8,0-1.5-0.7-1.5-1.5S15.2,22,16,22c0.8,0,1.5,0.7,1.5,1.5S16.8,25,16,25z" />
    <path className="an-icon__inner" d="M17.5,23.5c0,0.8-0.7,1.5-1.5,1.5c-0.8,0-1.5-0.7-1.5-1.5S15.2,22,16,22 C16.8,22,17.5,22.7,17.5,23.5z M17.1,8h-2.2v11h2.2V8z" />
  </Icon>
);
export const ErrorFilled = (p: Props) => <Icon {...p}><path d="M16,2A13.914,13.914,0,0,0,2,16,13.914,13.914,0,0,0,16,30,13.914,13.914,0,0,0,30,16,13.914,13.914,0,0,0,16,2Zm5.4449,21L9,10.5557,10.5557,9,23,21.4448Z" /></Icon>;
export const InformationFilled = (p: Props) => <Icon {...p}><path d="M16,2A14,14,0,1,0,30,16,14,14,0,0,0,16,2Zm0,6a1.5,1.5,0,1,1-1.5,1.5A1.5,1.5,0,0,1,16,8Zm4,16.125H12v-2.25h2.875v-5.75H13v-2.25h4.125v8H20Z" /></Icon>;
/** A ring with nothing in it: "not configured", which is not a failure. */
export const RadioButton = (p: Props) => <Icon {...p}><path d="M16,2A14,14,0,1,0,30,16,14,14,0,0,0,16,2Zm0,26A12,12,0,1,1,28,16,12,12,0,0,1,16,28Z" /></Icon>;
