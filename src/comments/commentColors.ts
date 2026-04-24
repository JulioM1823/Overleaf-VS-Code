import { OverleafCommentMessage } from './types';

export const DEFAULT_COMMENT_USER_PALETTE = [
    '#ef6b73',
    '#f6bb58',
    '#6fd36b',
    '#63b3ed',
    '#6b66e8',
    '#ef476f',
];

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function hueDistance(left: number, right: number) {
    const delta = Math.abs(left - right) % 360;
    return Math.min(delta, 360 - delta);
}

function hslToHex(hue: number, saturation: number, lightness: number) {
    const normalizedSaturation = saturation / 100;
    const normalizedLightness = lightness / 100;
    const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
    const huePrime = hue / 60;
    const intermediate = chroma * (1 - Math.abs(huePrime % 2 - 1));
    const match = normalizedLightness - chroma / 2;

    let red = 0;
    let green = 0;
    let blue = 0;

    if (huePrime >= 0 && huePrime < 1) {
        red = chroma;
        green = intermediate;
    } else if (huePrime < 2) {
        red = intermediate;
        green = chroma;
    } else if (huePrime < 3) {
        green = chroma;
        blue = intermediate;
    } else if (huePrime < 4) {
        green = intermediate;
        blue = chroma;
    } else if (huePrime < 5) {
        red = intermediate;
        blue = chroma;
    } else {
        red = chroma;
        blue = intermediate;
    }

    const toHex = (channel: number) => Math.round((channel + match) * 255).toString(16).padStart(2, '0');
    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function hexToHue(color: string) {
    const sanitized = color.replace('#', '');
    const red = Number.parseInt(sanitized.slice(0, 2), 16) / 255;
    const green = Number.parseInt(sanitized.slice(2, 4), 16) / 255;
    const blue = Number.parseInt(sanitized.slice(4, 6), 16) / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    if (delta===0) {
        return 0;
    }
    let hue = 0;
    if (max===red) {
        hue = ((green - blue) / delta) % 6;
    } else if (max===green) {
        hue = (blue - red) / delta + 2;
    } else {
        hue = (red - green) / delta + 4;
    }
    return Math.round((hue * 60 + 360) % 360);
}

function buildProtectedPaletteHues(palette: readonly string[]) {
    return palette.map(hexToHue);
}

export function isValidCommentUserColorHex(color: unknown): color is string {
    return typeof color === 'string' && HEX_COLOR_PATTERN.test(color.trim());
}

export function isValidCommentUserPalette(palette: unknown, expectedSize = DEFAULT_COMMENT_USER_PALETTE.length): palette is string[] {
    return Array.isArray(palette)
        && palette.length===expectedSize
        && palette.every(isValidCommentUserColorHex);
}

export function normalizeCommentUserPalette(
    palette: unknown,
    fallbackPalette: readonly string[] = DEFAULT_COMMENT_USER_PALETTE,
) {
    if (!isValidCommentUserPalette(palette, fallbackPalette.length)) {
        return [...fallbackPalette];
    }
    return palette.map((color) => color.trim().toLowerCase());
}

export function resolveCommentUserIdentifier(message: OverleafCommentMessage) {
    return message.user_id
        || message.user?.id
        || message.user?.email
        || message.user?.name
        || [message.user?.first_name, message.user?.last_name].filter(Boolean).join(' ')
        || `comment-author:${message.id}`;
}

export function resolveCommentUserColorByIndex(index: number, palette: readonly string[] = DEFAULT_COMMENT_USER_PALETTE) {
    if (index < palette.length) {
        return palette[index];
    }

    const protectedPaletteHues = buildProtectedPaletteHues(palette);
    let hue = (index - palette.length) * 137.508 + 24;
    hue %= 360;
    while (protectedPaletteHues.some((protectedHue) => hueDistance(protectedHue, hue) < 18)) {
        hue = (hue + 23) % 360;
    }
    return hslToHex(hue, 72, 62);
}
