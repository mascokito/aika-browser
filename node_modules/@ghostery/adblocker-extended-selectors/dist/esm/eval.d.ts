/*!
 * Copyright (c) 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type { AST } from './types.js';
export declare function matchPattern(pattern: string, text: string): boolean;
/**
 * Checks if the given element complies with the given selector.
 * @param element The subjective element.
 * @param selector The selector.
 */
export declare function matches(element: Element, selector: AST): boolean;
export declare function isExtendedSelector(selector: AST, insideHasSelector?: boolean): boolean;
export declare function querySelectorAll(element: Element, selector: AST): Element[];
/**
 * Executes pseudo-directive on the element.
 * @param element The target from normal or extended selector.
 * @param selector The AST only containing pseudo directive.
 */
export declare function handlePseudoDirective(element: Element, selector: AST): void;
//# sourceMappingURL=eval.d.ts.map