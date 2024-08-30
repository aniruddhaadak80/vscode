/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./nativeEditContext';
import { FastDomNode } from 'vs/base/browser/fastDomNode';
import { RenderingContext, RestrictedRenderingContext } from 'vs/editor/browser/view/renderingContext';
import { ViewController } from 'vs/editor/browser/view/viewController';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { Range } from 'vs/editor/common/core/range';
import * as dom from 'vs/base/browser/dom';
import { ViewContext } from 'vs/editor/common/viewModel/viewContext';
import * as viewEvents from 'vs/editor/common/viewEvents';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { EndOfLinePreference, IModelDeltaDecoration } from 'vs/editor/common/model';
import { KeyCode } from 'vs/base/common/keyCodes';
import { DebugEditContext } from 'vs/editor/browser/controller/editContext/native/debugEditContext';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { ClipboardStoredMetadata, getDataToCopy, InMemoryClipboardMetadataManager } from 'vs/editor/browser/controller/editContext/clipboardUtils';
import * as browser from 'vs/base/browser/browser';
import { editContextAddDisposableListener, EditContextState } from 'vs/editor/browser/controller/editContext/native/nativeEditContextUtils';
import { ITypeData } from 'vs/editor/browser/controller/editContext/screenReaderUtils';
import { AbstractEditContext } from 'vs/editor/browser/controller/editContext/editContext';
import { MOUSE_CURSOR_TEXT_CSS_CLASS_NAME } from 'vs/base/browser/ui/mouseCursor/mouseCursor';
import { ScreenReaderSupport } from 'vs/editor/browser/controller/editContext/native/screenReaderSupport';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { Position } from 'vs/editor/common/core/position';

// Boolean which controls whether we should show the control, selection and character bounds
const showControlBounds = false;

export class NativeEditContext extends AbstractEditContext {

	static NATIVE_EDIT_CONTEXT_CLASS_NAME = 'native-edit-context';

	// Dom element which holds screen reader content and handles key presses
	public readonly domNode: FastDomNode<HTMLDivElement>;

	// Edit Context
	private readonly _editContext: EditContext;
	private _currentEditContextState: EditContextState | undefined;

	private _decorations: string[] = [];
	private _parent: HTMLElement | undefined;
	private _compositionRange: Range | undefined;
	private _renderingContext: RenderingContext | undefined;

	// Screen reader support
	private readonly _screenReaderSupport: ScreenReaderSupport;

	// Field indicating whether dom element is focused
	private _hasFocus: boolean = false;

	constructor(
		context: ViewContext,
		private readonly _viewController: ViewController,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super(context);

		this.domNode = new FastDomNode(document.createElement('div'));
		this.domNode.setClassName(`${NativeEditContext.NATIVE_EDIT_CONTEXT_CLASS_NAME} ${MOUSE_CURSOR_TEXT_CSS_CLASS_NAME}`);

		this._editContext = showControlBounds ? new DebugEditContext() : new EditContext();
		this.domNode.domNode.editContext = this._editContext;

		this._screenReaderSupport = new ScreenReaderSupport(this.domNode, context, keybindingService);

		this._updateDomAttributes();

		this._register(dom.addDisposableListener(this.domNode.domNode, 'focus', () => this._setHasFocus(true)));
		this._register(dom.addDisposableListener(this.domNode.domNode, 'blur', () => this._setHasFocus(false)));
		this._register(dom.addDisposableListener(this.domNode.domNode, 'copy', async (e) => {
			this._ensureClipboardGetsEditorSelection();
		}));
		this._register(dom.addDisposableListener(this.domNode.domNode, 'keydown', async (e) => {

			const standardKeyboardEvent = new StandardKeyboardEvent(e);

			// When the IME is visible, the keys, like arrow-left and arrow-right, should be used to navigate in the IME, and should not be propagated further
			if (standardKeyboardEvent.keyCode === KeyCode.KEY_IN_COMPOSITION) {
				standardKeyboardEvent.stopPropagation();
			}
			// Enter key presses are not sent as text update events, hence we need to handle them outside of the text update event
			// The beforeinput and input events send `insertParagraph` and `insertLineBreak` events but only on input elements
			// Hence we handle the enter key press in the keydown event
			if (standardKeyboardEvent.keyCode === KeyCode.Enter) {
				this._emitAddNewLineEvent();
			}
			// See: https://issues.chromium.org/issues/40642681
			// The dom node on which edit context is set does not allow text modifications directly, as modifications should be done programmatically,
			// hence paste and cut requests are blocked and the events are not emitted. The paste and cut events are handled in the keydown event.
			if (standardKeyboardEvent.metaKey && standardKeyboardEvent.keyCode === KeyCode.KeyV) {
				e.preventDefault();
				const clipboardText = await this._clipboardService.readText();
				if (clipboardText !== '') {
					const metadata = InMemoryClipboardMetadataManager.INSTANCE.get(clipboardText);
					let pasteOnNewLine = false;
					let multicursorText: string[] | null = null;
					let mode: string | null = null;
					if (metadata) {
						pasteOnNewLine = (this._context.configuration.options.get(EditorOption.emptySelectionClipboard) && !!metadata.isFromEmptySelection);
						multicursorText = (typeof metadata.multicursorText !== 'undefined' ? metadata.multicursorText : null);
						mode = metadata.mode;
					}
					this._viewController.paste(clipboardText, pasteOnNewLine, multicursorText, mode);
				}
			}
			if (standardKeyboardEvent.metaKey && standardKeyboardEvent.keyCode === KeyCode.KeyX) {
				this._ensureClipboardGetsEditorSelection();
				this._viewController.cut();
			}
			this._viewController.emitKeyDown(standardKeyboardEvent);
		}));
		this._register(dom.addDisposableListener(this.domNode.domNode, 'keyup', (e) => {
			this._viewController.emitKeyUp(new StandardKeyboardEvent(e));
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'textupdate', e => {
			console.log('textupdate');
			if (this._compositionRange) {
				const position = this._context.viewModel.getPrimaryCursorState().viewState.position;
				this._compositionRange = this._compositionRange.setEndPosition(position.lineNumber, position.column);
			}
			this._emitTypeEvent(e);
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'compositionstart', e => {
			const position = this._context.viewModel.getPrimaryCursorState().viewState.position;
			this._compositionRange = Range.fromPositions(position, position);
			// Utlimately fires onDidCompositionStart() on the editor to notify for example suggest model of composition state
			// Updates the composition state of the cursor controller which determines behavior of typing with interceptors
			this._viewController.compositionStart();
			// Emits ViewCompositionStartEvent which can be depended on by ViewEventHandlers
			this._context.viewModel.onCompositionStart();
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'compositionend', e => {
			this._compositionRange = undefined;
			// Utlimately fires compositionEnd() on the editor to notify for example suggest model of composition state
			// Updates the composition state of the cursor controller which determines behavior of typing with interceptors
			this._viewController.compositionEnd();
			// Emits ViewCompositionEndEvent which can be depended on by ViewEventHandlers
			this._context.viewModel.onCompositionEnd();
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'textformatupdate', e => {
			this._handleTextFormatUpdate(e);
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'characterboundsupdate', e => {
			this._updateCharacterBounds();
		}));
	}

	public override dispose(): void {
		super.dispose();
	}

	appendTo(overflowGuardContainer: FastDomNode<HTMLElement>): void {
		overflowGuardContainer.appendChild(this.domNode);
		this._parent = overflowGuardContainer.domNode;
	}

	private _emitAddNewLineEvent(): void {
		const textBeforeSelection = this._editContext.text.substring(0, this._editContext.selectionStart);
		const textAfterSelection = this._editContext.text.substring(this._editContext.selectionEnd);
		const textAfterAddingNewLine = textBeforeSelection + '\n' + textAfterSelection;
		this._editContext.updateText(0, Number.MAX_SAFE_INTEGER, textAfterAddingNewLine);
		this._onType({
			text: '\n',
			replacePrevCharCnt: 0,
			replaceNextCharCnt: 0,
			positionDelta: 0,
		});
	}

	private _emitTypeEvent(e: { text: string; updateRangeStart: number; updateRangeEnd: number }) {
		console.log('_emitTypeEvent');
		if (!this._currentEditContextState) {
			console.log('early return');
			return;
		}
		console.log('e : ', e);
		console.log('this._currentEditContextState : ', this._currentEditContextState);
		let replaceNextCharCnt = 0;
		let replacePrevCharCnt = 0;
		if (e.updateRangeEnd > this._currentEditContextState.selectionEndOffset) {
			replaceNextCharCnt = e.updateRangeEnd - this._currentEditContextState.selectionEndOffset;
		}
		if (e.updateRangeStart < this._currentEditContextState.selectionStartOffset) {
			replacePrevCharCnt = this._currentEditContextState.selectionStartOffset - e.updateRangeStart;
		}
		let text = '';
		if (this._currentEditContextState.selectionStartOffset < e.updateRangeStart) {
			text += this._currentEditContextState.content.substring(this._currentEditContextState.selectionStartOffset, e.updateRangeStart);
		}
		text += e.text;
		if (this._currentEditContextState.selectionEndOffset > e.updateRangeEnd) {
			text += this._currentEditContextState.content.substring(e.updateRangeEnd, this._currentEditContextState.selectionEndOffset);
		}
		const typeInput: ITypeData = {
			text,
			replacePrevCharCnt,
			replaceNextCharCnt,
			positionDelta: 0,
		};
		console.log('typeInput : ', typeInput);
		this._onType(typeInput);
	}

	public setAriaOptions(): void {
		this._screenReaderSupport.setAriaOptions();
	}

	public getLastRenderData(): Position | null {
		return this._screenReaderSupport.getLastRenderData();
	}

	public prepareRender(ctx: RenderingContext): void {
		console.log('prepareRender');
		this._screenReaderSupport.prepareRender(ctx);
		this._updateEditContext();
		this._updateBounds();
	}

	public render(ctx: RestrictedRenderingContext): void {
		this._screenReaderSupport.render(ctx);
	}

	public override onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		this._screenReaderSupport.onCursorStateChanged(e);
		return true;
	}

	public override onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		this._screenReaderSupport.onScrollChanged(e);
		return true;
	}

	public override onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		this._screenReaderSupport.onConfigurationChanged(e);
		this._updateDomAttributes();
		return true;
	}

	private _updateDomAttributes(): void {
		const options = this._context.configuration.options;
		this.domNode.domNode.setAttribute('tabindex', String(options.get(EditorOption.tabIndex)));
	}

	private _updateEditContext(): void {
		console.log('_updateEditContext');
		this._currentEditContextState = this._getEditContextState();
		this._editContext.updateText(0, Number.MAX_SAFE_INTEGER, this._currentEditContextState.content);
		this._editContext.updateSelection(this._currentEditContextState.selectionStartOffset, this._currentEditContextState.selectionEndOffset);
		console.log('this._editContext.text : ', this._editContext.text);
		console.log('this._editContext.selectionStart : ', this._editContext.selectionStart);
		console.log('this._editContext.selectionEnd : ', this._editContext.selectionEnd);
		console.log('this._currentEditContextState : ', this._currentEditContextState);
	}

	public setRenderingContext(renderingContext: RenderingContext): void {
		this._renderingContext = renderingContext;
	}

	public writeScreenReaderContent(): void {
		this._screenReaderSupport.writeScreenReaderContent();
	}

	public isFocused(): boolean {
		return this._hasFocus;
	}

	public focus(): void {
		this._setHasFocus(true);
		this.refreshFocus();
	}

	public refreshFocus(): void {
		const hasFocus = dom.getActiveElement() === this.domNode.domNode;
		this._setHasFocus(hasFocus);
	}

	private _setHasFocus(newHasFocus: boolean): void {
		console.log('_setHasFocus');
		console.log('newHasFocus : ', newHasFocus);
		if (this._hasFocus === newHasFocus) {
			// no change
			return;
		}
		this._hasFocus = newHasFocus;
		if (this._hasFocus) {
			this.domNode.domNode.focus();
			this._context.viewModel.setHasFocus(true);
		} else {
			this._context.viewModel.setHasFocus(false);
		}
	}

	private _onType(typeInput: ITypeData): void {
		if (typeInput.replacePrevCharCnt || typeInput.replaceNextCharCnt || typeInput.positionDelta) {
			this._viewController.compositionType(typeInput.text, typeInput.replacePrevCharCnt, typeInput.replaceNextCharCnt, typeInput.positionDelta);
		} else {
			this._viewController.type(typeInput.text);
		}
	}

	private _getEditContextState(): EditContextState {
		const selection = this._context.viewModel.getPrimaryCursorState().viewState.selection;
		const selectionStartOffset = selection.startColumn - 1;
		let selectionEndOffset: number = 0;
		for (let i = selection.startLineNumber; i <= selection.endLineNumber; i++) {
			if (i === selection.endLineNumber) {
				selectionEndOffset += selection.endColumn - 1;
			} else {
				selectionEndOffset += this._context.viewModel.getLineMaxColumn(i);
			}
		}
		const endColumnOfEndLineNumber = this._context.viewModel.getLineMaxColumn(selection.endLineNumber);
		const rangeOfContent = new Range(selection.startLineNumber, 1, selection.endLineNumber, endColumnOfEndLineNumber);
		const content = this._context.viewModel.getValueInRange(rangeOfContent, EndOfLinePreference.TextDefined);
		return {
			content,
			selectionStartOffset,
			selectionEndOffset,
			rangeOfContent
		};
	}

	private _handleTextFormatUpdate(e: TextFormatUpdateEvent): void {
		if (!this._currentEditContextState) {
			return;
		}
		const formats = e.getTextFormats();
		const rangeOfEditContextText = this._currentEditContextState.rangeOfContent;
		const decorations: IModelDeltaDecoration[] = [];
		formats.forEach(f => {
			const textModel = this._context.viewModel.model;
			const offsetOfEditContextText = textModel.getOffsetAt(rangeOfEditContextText.getStartPosition());
			const startPositionOfDecoration = textModel.getPositionAt(offsetOfEditContextText + f.rangeStart);
			const endPositionOfDecoration = textModel.getPositionAt(offsetOfEditContextText + f.rangeEnd);
			const decorationRange = Range.fromPositions(startPositionOfDecoration, endPositionOfDecoration);
			const classNames = [
				'ime',
				`underline-style-${f.underlineStyle.toLowerCase()}`,
				`underline-thickness-${f.underlineThickness.toLowerCase()}`,
			];
			decorations.push({
				range: decorationRange,
				options: {
					description: 'textFormatDecoration',
					inlineClassName: classNames.join(' '),
				}
			});
		});
		this._decorations = this._context.viewModel.model.deltaDecorations(this._decorations, decorations);
	}

	private _updateBounds() {
		this._updateSelectionAndControlBounds();
		this._updateCharacterBounds();
	}

	private _updateSelectionAndControlBounds() {
		if (!this._parent) {
			return;
		}
		const selection = this._context.viewModel.getPrimaryCursorState().viewState.selection;
		const parentBounds = this._parent.getBoundingClientRect();
		const verticalOffsetStart = this._context.viewLayout.getVerticalOffsetForLineNumber(selection.startLineNumber);
		const editorScrollTop = this._context.viewLayout.getCurrentScrollTop();
		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);
		const contentLeft = options.get(EditorOption.layoutInfo).contentLeft;

		let width: number;
		let height: number;
		let left = parentBounds.left + contentLeft;
		if (selection.isEmpty()) {
			if (this._renderingContext) {
				const linesVisibleRanges = this._renderingContext.linesVisibleRangesForRange(selection, true) ?? [];
				if (linesVisibleRanges.length > 0) {
					left += Math.min(...linesVisibleRanges.map(r => Math.min(...r.ranges.map(r => r.left))));
				} else {
					const characterBounds = this._editContext.characterBounds()[0];
					if (characterBounds) {
						left = characterBounds.left;
					}
				}
			}
			width = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth / 2;
			height = lineHeight;
		} else {
			width = parentBounds.width - contentLeft;
			height = (selection.endLineNumber - selection.startLineNumber + 1) * lineHeight;
		}
		const top = parentBounds.top + verticalOffsetStart - editorScrollTop;
		const selectionBounds = new DOMRect(left, top, width, height);
		const controlBounds = selectionBounds;
		this._editContext.updateControlBounds(controlBounds);
		this._editContext.updateSelectionBounds(selectionBounds);
	}

	private _updateCharacterBounds() {
		if (!this._parent || !this._compositionRange || !this._currentEditContextState) {
			return;
		}
		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);
		const contentLeft = options.get(EditorOption.layoutInfo).contentLeft;
		const typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		const parentBounds = this._parent.getBoundingClientRect();
		const verticalOffsetStart = this._context.viewLayout.getVerticalOffsetForLineNumber(this._compositionRange.startLineNumber);
		const editorScrollTop = this._context.viewLayout.getCurrentScrollTop();
		const top = parentBounds.top + verticalOffsetStart - editorScrollTop;

		let left: number = parentBounds.left + contentLeft;
		let width: number = typicalHalfwidthCharacterWidth;
		if (this._renderingContext) {
			const linesVisibleRanges = this._renderingContext.linesVisibleRangesForRange(this._compositionRange, true) ?? [];
			if (linesVisibleRanges.length > 0) {
				const minLeft = Math.min(...linesVisibleRanges.map(r => Math.min(...r.ranges.map(r => r.left))));
				const maxLeft = Math.max(...linesVisibleRanges.map(r => Math.max(...r.ranges.map(r => r.left + r.width))));
				left += minLeft;
				width = maxLeft - minLeft;
			} else {
				const characterBounds = this._editContext.characterBounds()[0];
				if (characterBounds) {
					left = characterBounds.left;
					width = characterBounds.width;
				}
			}
		}
		const characterBounds = [new DOMRect(left, top, width, lineHeight)];

		const textModel = this._context.viewModel.model;
		const offsetOfEditContextStart = textModel.getOffsetAt(this._currentEditContextState.rangeOfContent.getStartPosition());
		const offsetOfCompositionStart = textModel.getOffsetAt(this._compositionRange.getStartPosition());
		const offsetOfCompositionStartInEditContext = offsetOfCompositionStart - offsetOfEditContextStart;
		this._editContext.updateCharacterBounds(offsetOfCompositionStartInEditContext, characterBounds);
	}

	private _ensureClipboardGetsEditorSelection(): void {
		const options = this._context.configuration.options;
		const emptySelectionClipboard = options.get(EditorOption.emptySelectionClipboard);
		const copyWithSyntaxHighlighting = options.get(EditorOption.copyWithSyntaxHighlighting);
		const selections = this._context.viewModel.getCursorStates().map(cursorState => cursorState.modelState.selection);
		const dataToCopy = getDataToCopy(this._context.viewModel, selections, emptySelectionClipboard, copyWithSyntaxHighlighting);
		const storedMetadata: ClipboardStoredMetadata = {
			version: 1,
			isFromEmptySelection: dataToCopy.isFromEmptySelection,
			multicursorText: dataToCopy.multicursorText,
			mode: dataToCopy.mode
		};
		InMemoryClipboardMetadataManager.INSTANCE.set(
			// When writing "LINE\r\n" to the clipboard and then pasting,
			// Firefox pastes "LINE\n", so let's work around this quirk
			(browser.isFirefox ? dataToCopy.text.replace(/\r\n/g, '\n') : dataToCopy.text),
			storedMetadata
		);
		this._clipboardService.writeText(dataToCopy.text);
	}
}
