'use client';
import {QRCodeSVG} from 'qrcode.react';

export function TicketQr({url}:{url:string}){
  return <div className="public-ticket-qr" aria-label="Código QR de la entrada">
    <QRCodeSVG value={url} size={320} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" title="Código QR para ingresar"/>
  </div>;
}
