# Fase 3C — nota comercial

La comunicación confirmada para la experiencia visual es:

- `HOMBRES` — `$500 MXN`.
- `MUJERES` — promoción comunicada como `$1 USD`.

El tipo `MUJERES` no debe persistirse como configuración definitiva hasta definir la moneda efectiva de cobro y liquidación del checkout futuro. No se realiza conversión USD→MXN en la interfaz ni se habilita mezclar monedas dentro de una orden. La invariante de moneda única del dominio permanece vigente.
