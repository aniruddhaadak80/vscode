/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FastDomNode } from 'vs/base/browser/fastDomNode';
import { IEditorAriaOptions } from 'vs/editor/browser/editorBrowser';
import { ViewPart } from 'vs/editor/browser/view/viewPart';
import { Position } from 'vs/editor/common/core/position';

export abstract class AbstractEditContext extends ViewPart {
	abstract domNode: FastDomNode<HTMLElement>;
	abstract appendTo(overflowGuardContainer: FastDomNode<HTMLElement>): void;
	abstract focus(): void;
	abstract isFocused(): boolean;
	abstract refreshFocus(): void;
	abstract setAriaOptions(options: IEditorAriaOptions): void;
	abstract getLastRenderData(): Position | null;
	abstract writeScreenReaderContent(reason: string): void;
}