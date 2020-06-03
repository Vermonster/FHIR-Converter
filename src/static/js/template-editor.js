// -------------------------------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License (MIT). See LICENSE in the repo root for license information.
// -------------------------------------------------------------------------------------------------

var version = '1.0';

var messageEditor;
var templateCodeEditor;
var outputCode;
var lineMapping = []; // Mapping source (template) to destination (output) lines
var lastScrollPositions = {};
var skipScrollHandlers = {};
var lastScrollEditors = [];
var activeTemplate = { name: 'untitled', parent: null, data: '{}', active: true, marks: [] };
var openTemplates = [activeTemplate];
var currentTemplateReference = { [activeTemplate.name]: activeTemplate.data }; // This is what we set the template to initially
var latestRequest = 0;
var nextRequestCall;
var waitForTypingTimeout = 100;
var bannerFade;
var transitionTime = 1000;
var uncheckedApiKey = false;
// eslint-disable-next-line no-unused-vars
var templateNames;

// The chosen color schemes also need to have their stylesheets linked in the index.html file
var darkMode = "blackboard";
var lightMode = "eclipse";

var currentEditorSettings = { scrollSync: true, darkMode: false };
var apiKey = '';
var maskedApiKey = '***********';
var hasSuccessfulCallBeenMade = false;

var currentMessageType;
var templateOutputSplit;
var messageTemplateSplit;

var messageTypeMappings = {
    'HL7v2': 'hl7',
    'CDA': 'cda'
}

function getSettings() {
    return currentEditorSettings;
}

function setSettings(settings) {
    currentEditorSettings = settings;
}

function getApiKey() {
    return ((apiKey === maskedApiKey) ? '' : apiKey);
}

function getUrl(endpoint, fileName) {
    return '/api/' + endpoint + '/' + currentMessageType + (filename ? '/' + fileName : '') + '?api-version=' + version;
}

function checkApiKey(successFunc, errorFunc) {
    $.ajax(getUrl('templates'), {
        'type': 'GET',
        'processData': false,
        'beforeSend': function (request) {
            request.setRequestHeader("X-MS-CONVERSION-API-KEY", getApiKey());
        },
        'success': function (templateList) {
            hasSuccessfulCallBeenMade = true;
            templateList.templates.map(template => template.templateName);
            // eslint-disable-next-line no-undef
            initHelperList();
            uncheckedApiKey = false;
            if (successFunc) successFunc();
        },
        'error': function () {
            hasSuccessfulCallBeenMade = false;
            if (errorFunc) errorFunc();
        }
    });
}

function checkApiKeyAndRaiseModal(userRequestedValidation) {
    checkApiKey(
        function () {
            $('#settings-modal').modal('hide');
            $('#settings-modal-alert').hide();
        },
        function () {
            $('#settings-modal').modal('show');
            if ($('#api-key-input').val() || userRequestedValidation) {
                $('#settings-modal-alert').show();
                $('#settings-modal-alert').html("<strong>Error: </strong>Invalid API Key");
            }
        }
    );
}

function convertMessage(resetOutputScroll) {
    if (nextRequestCall) {
        clearTimeout(nextRequestCall);
    }

    nextRequestCall = setTimeout(() => {
        var reqBody = {};
        var replacementDictionary = {};
        var templateLines = [];
        var outputLines = [];

        var scrollInfo = outputCode.getScrollInfo();

        if (messageEditor.getValue()) {
            reqBody.messageBase64 = btoa(messageEditor.getValue().replace(/[^\x00-\x7F]/g, "")); //TODO
        }

        var topTemplate = openTemplates.find(template => template.parent === null);
        if (topTemplate) {
            templateLines = topTemplate.data.replace(/(?:\r\n|\r|\n)/g, '\n').split('\n');

            if (activeTemplate === topTemplate && getSettings().scrollSync) {
                // Match the first property, e.g., '"propname":'
                // Note, we will exclude properties that have a $ in the name, 
                // since we will use that as a label. 
                var propertyRegEx = /"[^("|$|{|})]+":/;
                var excludeRegex = /entry|resource|resourceType|id|meta|versionId/; // for using these keys on server side
                for (var i = 0; i < templateLines.length; i++) {
                    var lineProps = templateLines[i].match(propertyRegEx);
                    if (lineProps && lineProps.length > 0 && !excludeRegex.test(templateLines[i])) {
                        var placeHolder = '"$' + i + '$":';
                        replacementDictionary[placeHolder] = lineProps[0];

                        // Replacing on the regex instead of the actual match, 
                        // since we could have multiple matches and we just want the first.
                        templateLines[i] = templateLines[i].replace(propertyRegEx, placeHolder);
                    }
                }
            }

            var partialTemplates = openTemplates.filter(template => template.parent !== null);

            var partialTemplatesMap = {};
            partialTemplates.forEach(template => partialTemplatesMap[template.name] = template.data);

            reqBody.templateBase64 = btoa(templateLines.join('\n'));
            reqBody.templatesMapBase64 = btoa(JSON.stringify(partialTemplatesMap));
            reqBody.replacementDictionaryBase64 = btoa(JSON.stringify(replacementDictionary));
        }

        latestRequest++;
        const requestNumber = latestRequest;
        $.ajax(getUrl('convert'), {
            'data': JSON.stringify(reqBody),
            'type': 'POST',
            'processData': false,
            'contentType': 'application/json',
            'beforeSend': function (request) {
                request.setRequestHeader("X-MS-CONVERSION-API-KEY", getApiKey());
            },
            'success': function (data) {
                if (latestRequest === requestNumber) {
                    // Formatting output and splitting on line breaks (taking platform variations into consideration)
                    outputLines = JSON.stringify(data.fhirResource, null, 2).replace(/(?:\r\n|\r|\n)/g, '\n').split('\n');

                    // Reset line mappings
                    if (activeTemplate === topTemplate && getSettings().scrollSync) {
                        lineMapping = [];
                        lineMapping.push({ source: 0, destination: 0 });
                        if (templateLines.length > 1 && outputLines.length > 1) {
                            lineMapping.push({ source: templateLines.length - 1, destination: outputLines.length - 1 });
                        }

                        // Loop through lines and undo substitutions while building line mapping
                        var substitutionRegEx = /"\$([0-9]+)\$":/;
                        for (var i = 0; i < outputLines.length; i++) {
                            var subMatch = outputLines[i].match(substitutionRegEx);
                            if (subMatch && subMatch.length > 0) {
                                lineMapping.push({ source: Number(subMatch[1]), destination: i });
                                outputLines[i] = outputLines[i].replace(substitutionRegEx, replacementDictionary[subMatch[0]]);
                            }
                        }
                    }

                    outputCode.setValue(outputLines.join('\n'));
                    if (!resetOutputScroll) {
                        setSkipNextScrollHandler(outputCode, true);
                        outputCode.scrollTo(null, scrollInfo.top);
                    }

                    // Makes the unused line marking asyc to help performance.
                    setTimeout(() => {
                        if (latestRequest === requestNumber) {
                            // Highlights unused sections of the Hl7 message
                            var unusedReport = data.unusedSegments;
                            var messageDoc = messageEditor.getDoc();

                            var fieldSeparator = messageDoc.getLine(0)[3];
                            var componentSeparator = messageDoc.getLine(0)[4];

                            // Removes all the old highlighting
                            messageDoc.getAllMarks().forEach((mark) => mark.clear());

                            unusedReport.forEach((line) => {
                                line.field.forEach((field) => {
                                    if (field && field.index !== 0 && field.component.length > 0) {
                                        field.component.forEach((component) => {
                                            var lineText = messageDoc.getLine(line.line);
                                            var startFieldIndex = indexOfX(lineText, fieldSeparator, field.index - 1) + 1;
                                            var endFieldIndex = indexOfX(lineText, fieldSeparator, field.index);
                                            if (endFieldIndex === -1) {
                                                endFieldIndex = lineText.length;
                                            }

                                            var startComponentIndex = indexOfX(lineText.substring(startFieldIndex, endFieldIndex), componentSeparator, component.index - 1) + startFieldIndex + 1;
                                            var endComponentIndex = startComponentIndex + component.value.length;
                                            messageDoc.markText({ line: line.line, ch: startComponentIndex }, { line: line.line, ch: endComponentIndex }, { className: 'unused-segment' });
                                        });
                                    }
                                });
                            });
                        }
                    }, 0);
                }

            },
            'error': function (err) {
                try {
                    var errObj = JSON.parse(err.responseText);
                    outputCode.setValue(`{${errObj.error.code}: ${errObj.error.message}}`);
                }
                catch (ex) {
                    outputCode.setValue('Unable to convert: ' + JSON.stringify(err));
                }
            }
        });
    }, waitForTypingTimeout);
}

function indexOfX(source, target, number, offset = 0) {
    if (offset === -1 || number < 0) {
        return -1;
    }
    else if (number === 0) {
        return source.indexOf(target, offset);
    }

    return indexOfX(source, target, number - 1, source.indexOf(target, offset) + 1);
}

function setColorTheme(isDarkMode) {
    var addColor = isDarkMode ? "dark" : "light";
    var removeColor = isDarkMode ? "light" : "dark";

    var body = $('body');
    body.removeClass("bg-" + removeColor);
    body.addClass("bg-" + addColor);

    var navbar = $('#navbar');
    navbar.removeClass("bg-" + removeColor);
    navbar.removeClass("navbar-" + removeColor);

    navbar.addClass("bg-" + addColor);
    navbar.addClass("navbar-" + addColor);

    var templateTabs = $('#template-tabs');
    templateTabs.removeClass("bg-" + removeColor);
    navbar.addClass("bg-" + addColor);

    var buttons = [$('#template-save-button'), $('#refresh-button'), $('#settings-save-button')];
    buttons.forEach((btn) => {
        // buttons are inverted to stand out
        btn.removeClass("btn-" + addColor);
        btn.addClass("btn-" + removeColor);
    });

    var settingsModal = $('#settings-modal-content');
    settingsModal.removeClass("bg-" + removeColor);
    settingsModal.removeClass("text-" + addColor);

    settingsModal.addClass("bg-" + addColor);
    settingsModal.addClass("text-" + removeColor);

    messageEditor.setOption("theme", isDarkMode ? darkMode : lightMode);
    outputCode.setOption("theme", isDarkMode ? darkMode : lightMode);
    templateCodeEditor.setOption("theme", isDarkMode ? darkMode : lightMode);
}

function displayBanner(message, cssClass) {
    var delay = 0;
    var banner = $('#banner');

    if (bannerFade) {
        clearTimeout(bannerFade);
        banner.slideUp(transitionTime);
        delay = transitionTime;
    }

    bannerFade = setTimeout(() => {
        $('#banner-message')[0].innerText = message;
        banner.removeClass();
        banner.addClass('alert ' + cssClass);
        banner.slideDown(transitionTime);

        bannerFade = setTimeout(() => {
            banner.slideUp(transitionTime);
            bannerFade = null;
        }, 5000);
    }, delay);
}

function underlinePartialTemplateNames(document, change) {
    var startLine = change ? change.from.line : document.firstLine();
    var endLine = (change ? change.to.line : document.lastLine()) + 1;

    // remove marks before adding new one, only check changed lines if passed
    activeTemplate.marks = activeTemplate.marks.filter(mark => {
        var section = mark.find();
        if (section) {
            if (section.from.line >= startLine && section.to.line < endLine) {
                mark.clear();
                return false;
            }
        }
        else {
            return false;
        }

        return true;
    });

    document.eachLine(startLine, endLine, (line) => {
        var nameLocation = getPartialTemplateNameLocation(line.text);
        if (nameLocation) {
            activeTemplate.marks.push(
                document.markText(
                    {
                        line: line.lineNo(),
                        ch: nameLocation.start
                    },
                    {
                        line: line.lineNo(),
                        ch: nameLocation.end
                    },
                    {
                        className: "underline"
                    }));
        }
    });
}

function getPartialTemplateNameLocation(lineText) {
    var startPoint = lineText.indexOf("{{>");

    if (startPoint !== -1) {
        var nextWhitespace = lineText.indexOf(" ", startPoint);
        var handlebarEnd = lineText.indexOf("}}", startPoint);
        var endPoint = nextWhitespace < handlebarEnd && nextWhitespace !== -1 ? nextWhitespace : handlebarEnd;

        if (endPoint !== -1) {
            var templateName = lineText.substring(startPoint + 3, endPoint);
            if (isTemplateName(templateName)) {
                return { start: startPoint + 3, end: endPoint, name: templateName };
            }
        }
    }

    return null;
}

function unchangedFromReference(templateName, templateData) {
    var newLineRegex = /(?:\r\n|\r|\n)/g;

    return templateData.replace(newLineRegex, '\n') === currentTemplateReference[templateName].replace(newLineRegex, '\n');
}

function changeMessageType(messageType) {
    $('#message-type-dropdown-button').text('FHIR Converter: ' + messageType);
    currentMessageType = messageTypeMappings[messageType];

    if (templateOutputSplit) {
        templateOutputSplit.destroy();
    }
    if (messageTemplateSplit) {
        messageTemplateSplit.destroy();
    }

    switch (messageType) {
        case 'HL7v2':
            $('#editor-wrapper').addClass('vertical-content');

            // Create splits for editor areas
            templateOutputSplit = Split(['.template-area', '.output-area'], {
                gutterSize: 5,
                sizes: [50, 50]
            });

            messageTemplateSplit = Split(['.msg-area', '.editor-area'], {
                gutterSize: 5,
                sizes: [30, 70],
                direction: 'vertical'
            });
            break;
        case 'CDA':
            $('#editor-wrapper').removeClass('vertical-content');

            // Create splits for editor areas
            templateOutputSplit = Split(['.template-area', '.output-area'], {
                gutterSize: 5,
                sizes: [50, 50]
            });

            messageTemplateSplit = Split(['.msg-area', '.editor-area'], {
                gutterSize: 5,
                sizes: [30, 70]
            });
            break;
    }
}

$(document).ready(function () {
    messageEditor = CodeMirror.fromTextArea(document.getElementById("messagebox"), {
        //readOnly: false,
        lineNumbers: true,
        theme: lightMode,
        mode: { name: "text/html" },
        extraKeys: { "Ctrl-Q": function (cm) { cm.foldCode(cm.getCursor()); } },
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"]
    });

    messageEditor.on("change", function () {
        convertMessage();
    });

    outputCode = CodeMirror.fromTextArea(document.getElementById("resultbox"), {
        readOnly: true,
        lineNumbers: true,
        theme: lightMode,
        mode: { name: "javascript" },
        extraKeys: { "Ctrl-Q": function (cm) { cm.foldCode(cm.getCursor()); } },
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"]
    });

    let extrakeysObj = {};
    extrakeysObj["Tab"] = function (cm) {
        var spaces = Array(5).join(" ");
        cm.replaceSelection(spaces);
    };

    templateCodeEditor = CodeMirror.fromTextArea(document.getElementById("templatebox"), {
        theme: lightMode,
        lineNumbers: true,
        /*global hintExtraKeysObj*/
        extraKeys: Object.assign(extrakeysObj, hintExtraKeysObj),
        mode: { name: "handlebars", base: "application/json" },
        smartIndent: false,
        matchBrackets: true
    });

    templateCodeEditor.on("change", function (instance, changeObj) {
        if (activeTemplate) {
            activeTemplate.data = templateCodeEditor.getValue();
            underlinePartialTemplateNames(templateCodeEditor.getDoc(), changeObj);

            if (unchangedFromReference(activeTemplate.name, activeTemplate.data)) {
                getTab(activeTemplate.name).removeClass("font-italic");
            }
            else {
                getTab(activeTemplate.name).addClass("font-italic");
            }
        }
        convertMessage();
    });

    templateCodeEditor.on('scroll', function () {
        if (activeTemplate.parent === null) {
            adjustScrolling(templateCodeEditor, outputCode, lineMapping.map(e => { return e.source; }), lineMapping.map(e => { return e.destination; }));
        }
    });

    templateCodeEditor.on('dblclick', function () {
        var doc = templateCodeEditor.getDoc();
        var cursorPos = doc.getCursor();
        var lineText = doc.getLine(cursorPos.line);
        var nameLocation = getPartialTemplateNameLocation(lineText);

        if (nameLocation && cursorPos.ch >= nameLocation.start && cursorPos.ch <= nameLocation.end) {
            addTab(nameLocation.name, activeTemplate.name);
        }
    });

    outputCode.on('scroll', function () {
        if (activeTemplate.parent === null) {
            adjustScrolling(outputCode, templateCodeEditor, lineMapping.map(e => { return e.destination; }), lineMapping.map(e => { return e.source; }));
        }
    });

    $("#message-type-dropdown").on('click', 'a', function () {
        changeMessageType($(this).text());
    });

    $('#template-dropdown-button').on('click', function () {
        loadTemplateOptions();
    });

    $('#message-dropdown-button').on('click', function () {
        loadMessageOptions();
    });

    $("#message-load-dropdown").on('click', 'a', function () {
        loadMessage($(this).text());
    });

    $('#git-dropdown-button').on('click', function () {
        loadGitMenu();
    });

    //Template save button
    $('#template-save-button').on('click', function () {
        saveTemplate();
    });

    $('#banner-close').on('click', function () {
        $('#banner').slideUp(transitionTime);
        clearTimeout(bannerFade);
        bannerFade = null;
    });

    $("#settings-modal").on('show.bs.modal', function () {
        uncheckedApiKey = true;
        $('#api-key-input').val(!hasSuccessfulCallBeenMade || apiKey === '' ? '' : maskedApiKey);
        $('#settings-scroll-sync').prop('checked', getSettings().scrollSync);
        $('#settings-dark-mode').prop('checked', getSettings().darkMode);
    });

    $('#api-key-input').on('input', function () {
        $('#settings-modal-alert').hide();
    });

    // We will not allow the API key modal to be closed if the API key is wrong. 
    $("#settings-modal").on('hidden.bs.modal', function () {
        if (uncheckedApiKey) {
            checkApiKey(undefined, function () { $('#settings-modal').modal('show'); });
        }
    });

    // API Key save button 
    $('#settings-save-button').on('click', function () {
        var settings = getSettings();
        var changesRequireNewConversion = false;
        var changesColorTheme = false;

        if (settings.scrollSync != $('#settings-scroll-sync').prop('checked')) {
            changesRequireNewConversion = true;
        }

        if (settings.darkMode != $('#settings-dark-mode').prop('checked')) {
            changesColorTheme = true;
        }

        settings.scrollSync = $('#settings-scroll-sync').prop('checked');
        settings.darkMode = $('#settings-dark-mode').prop('checked');

        var apiKeyInput = $('#api-key-input').val();
        apiKey = apiKeyInput === maskedApiKey ? apiKey : apiKeyInput;

        setSettings(settings);
        checkApiKeyAndRaiseModal(true);

        if (changesRequireNewConversion) {
            convertMessage();
        }

        if (changesColorTheme) {
            setColorTheme(settings.darkMode);
        }
    });

    $('#refresh-button').on('click', function () {
        convertMessage();
    });

    $("#new-branch-modal").on('show.bs.modal', function () {
        loadBaseBranches();
    });

    // New branch save button 
    $('#new-branch-create-button').on('click', function () {
        createBranch($('#branch-name-input').val(), $('#base-branch-select').val(), $("#checkout-new-branch").prop("checked") == true);
    });

    changeMessageType('HL7v2');

    // See if we have a valid API key and if not raise modal
    checkApiKeyAndRaiseModal();
});
