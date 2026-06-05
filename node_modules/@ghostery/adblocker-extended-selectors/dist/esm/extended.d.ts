/*!
 * Copyright (c) 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type { AST, PseudoClass } from './types.js';
export declare const EXTENDED_PSEUDO_CLASSES: Set<string>;
export declare const PSEUDO_CLASSES: Set<string>;
export declare const PSEUDO_ELEMENTS: Set<string>;
export declare const PSEUDO_DIRECTIVES: Set<string>;
export declare enum SelectorType {
    Normal = 0,
    Extended = 1,
    Invalid = 2
}
export declare function classifySelector(selector: string): SelectorType;
/**
 * Exposes ASTs per purpose. For an instance, it distinguishes
 * a directive selector from element selectors.
 * @returns "element" AST and "directive" AST; no "element" AST
 * means there's no selector, no "directive" AST means there's no
 * pseudo-directive.
 */
export declare function destructAST(ast: AST): {
    element: AST;
    directive: PseudoClass | null;
};
/**
 * Finds a position of a pseudo directive from the complete CSS
 * selector. You can split the selector into normal or extended
 * selector and pseudo directive using this function.
 * @returns The position of a pseudo directive, or -1
 */
export declare function indexOfPseudoDirective(selector: string): number;
//# sourceMappingURL=extended.d.ts.map