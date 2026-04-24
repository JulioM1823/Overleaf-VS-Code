import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import {
    DEFAULT_COMMENT_USER_PALETTE,
    isValidCommentUserPalette,
    normalizeCommentUserPalette,
} from './commentColors';

const COMMENT_COLOR_TAGS_CONFIGURATION_KEY = 'colorTags';

export interface ResolvedCommentUserPalette {
    configuredItemCount: number;
    isValid: boolean;
    palette: string[];
    usedDefaultPalette: boolean;
}

export function didCommentUserPaletteChange(event: vscode.ConfigurationChangeEvent) {
    return event.affectsConfiguration(`${ROOT_NAME}.${COMMENT_COLOR_TAGS_CONFIGURATION_KEY}`);
}

export function getConfiguredCommentUserPalette(): ResolvedCommentUserPalette {
    const configuredValue = vscode.workspace
        .getConfiguration(ROOT_NAME)
        .get<unknown>(COMMENT_COLOR_TAGS_CONFIGURATION_KEY);
    const configuredItemCount = Array.isArray(configuredValue) ? configuredValue.length : 0;
    const isValid = configuredValue===undefined || isValidCommentUserPalette(configuredValue, DEFAULT_COMMENT_USER_PALETTE.length);
    const palette = normalizeCommentUserPalette(configuredValue, DEFAULT_COMMENT_USER_PALETTE);
    return {
        configuredItemCount,
        isValid,
        palette,
        usedDefaultPalette: configuredValue!==undefined && !isValid,
    };
}
