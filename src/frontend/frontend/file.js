/**
 * Seashell's frontend edit file controller
 * Copyright (C) 2013-2015 The Seashell Maintainers.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * See also 'ADDITIONAL TERMS' at the end of the included LICENSE file.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* jshint supernew: true */
angular.module('frontend-app')
  .controller('EditFileController', ['$state', '$scope', '$timeout', '$q', 'openProject', 'openQuestion',
      'openFolder', 'openFile', 'error-service', 'settings-service', 'console-service', 'RenameFileModal',
      'ConfirmationMessageModal', '$window', '$document', 'hotkeys', 'scrollInfo', 'undoHistory', 'socket',
      function($state, $scope, $timeout, $q, openProject, openQuestion, openFolder, openFile, errors,
          settings, Console, renameModal, confirmModal, $window, $document, hotkeys, scrollInfo, undoHistory,
          ws) {
        var self = this;
        // Scope variable declarations follow.

        // These are all arguments passed into the controller,
        // and persist after the controller is destroyed.
        self.project = openProject;
        self.question = openQuestion;
        self.folder = openFolder;
        self.file = openFile;
        self.console = Console;
        self.settings = settings;
        self.undoHistory = undoHistory;

        // Instance fields.
        self.scrollInfo = scrollInfo;
        self.isBinaryFile = false;
        self.ready = false;
        self.ext = self.file.split(".")[1];
        self.runnerFile = false; // true if a runner file is present in the project
        self.isFileToRun = false; // true if the current file is the runner file
        self.editor = null;
        self.timeout = null;
        self.loaded = false;
        self.editorOptions = {}; // Wait until we grab settings to load this.
        self.consoleEditor = null;
        self.consoleOptions = {};
        /** Callback key when connected.
         *  NOTE: This is slightly sketchy -- however, as
         *  the editor will only be loaded if and only if
         *  the socket exists in the first place, this is
         *  fine for now. */
        var cbC_key = ws.register_callback('connected', function () {
          if (self.editor)
            self.editor.setOption("readOnly", false);
        }, true);
        var cbF_key = ws.register_callback('failed', function () {
          if (self.editor)
            self.editor.setOption("readOnly", true);
        }, true);
        var cbD_key = ws.register_callback('disconnected', function () {
          if (self.editor)
            self.editor.setOption("readOnly", true);
        }, true);
        $scope.$on('$destroy', function(){
          var scr = self.editor.getScrollInfo();
          if(undefined===self.scrollInfo[self.folder])
            self.scrollInfo[self.folder] = {};
          self.scrollInfo[self.folder][self.file] =
            {top:scr.top, left:scr.left, line:self.line, col:self.col};
          if(undefined===self.undoHistory[self.folder])
            self.undoHistory[self.folder] = {};
          self.undoHistory[self.folder][self.file] = self.editor.getHistory();
          ws.unregister_callback(cbC_key);
          ws.unregister_callback(cbF_key);
          ws.unregister_callback(cbD_key);
        });
        self.editorFocus = false;
        self.contents = "";
        var mime = {"c" : "text/x-c", "h" : "text/x-c", "rkt" : "text/x-scheme"}[self.ext] || "text/plain";
        // Saving event.
        function runWhenSaved(fn) {
          if (self.timeout) {
            $timeout.cancel(self.timeout);
            self.timeout = null;
            self.project.saveFile(self.question, self.folder, self.file, self.contents).then(function (){
                fn();
              })
              .catch(function (error) {
                errors.report(error, "Could not save file!");
              });
          } else {
            fn();
          }
        }
        $scope.$on('run-when-saved', function (evt, fn) {
          runWhenSaved(fn);
        });
        self.activateResize = function(){
          settings.settings.force_narrow = !(settings.settings.force_narrow);
          settings.save();
        };
        // Resize on window size change
        function onResize() {
          var narrow = (settings.settings.force_narrow || $window.innerWidth < 992);
          var min_height = 500, margin_bottom = 30;
          var editor_elem = $window.document.querySelector("#editor > .CodeMirror");
          var console_elem = $window.document.querySelector("#console > .CodeMirror");
          // Run only when DOM is ready.
          if (editor_elem && console_elem) {
            var target_height = Math.max($window.innerHeight - editor_elem.getBoundingClientRect().top - margin_bottom, min_height);
            var file_control_height = $window.document.querySelector('#current-file-controls').offsetHeight;
            var console_input_height = $window.document.querySelector('#console-input').offsetHeight;
            if (editor_elem)
              editor_elem.style.height = sprintf("%fpx",
                (narrow ? target_height * 0.7 : target_height) - file_control_height);
            if (console_elem)
              console_elem.style.height = sprintf("%fpx",
                (narrow ? (target_height * 0.3 - file_control_height) : target_height) - console_input_height);
            if(self.editor)
              self.editor.refresh();
            if(self.consoleEditor)
              self.consoleEditor.refresh();
            // Force the font size at any rate (and font name)
            _.each($window.document.querySelectorAll('.CodeMirror'),
                function (elem) {
                  elem.style['font-family'] = sprintf("%s, monospace", settings.settings.font);
                  elem.style['font-size'] = sprintf("%dpt", parseInt(settings.settings.font_size));
                });
          }
        }
        $scope.$on('window-resized', onResize);
        // Scope helper function follow.
        self.consoleLoad = function(console_cm) {
          self.consoleEditor = console_cm;
          self.consoleEditor.on("change", function() {
            var scr = self.consoleEditor.getScrollInfo();
            self.consoleEditor.scrollTo(scr.left, scr.height);
          });
          $timeout(onResize, 0);
        };
        self.editorLoad = function(editor) {
          self.editor = editor;
          if (self.ext === "c" || self.ext === "h") {
            CodeMirror.registerHelper("lint","clike",function() {
              var found = [];
              _.forEach(self.console.errors,function(err) {
                var error = err[0], file = err[1].split("/");
                file = file[file.length-1];
                var line = _.max([err[2] - 1, 0]), column = err[3] - 1;
                var message = err[4];
                console.log(err);
                if (_.contains([self.file,
                                'final-link-result'],
                               file))
                  found.push({ from: CodeMirror.Pos(line, column),
                               to: CodeMirror.Pos(line),
                               message: message,
                               severity: error ? 'error' : 'warning' });
              });
              return found;
            });
            self.editor.setOption("gutters", ["CodeMirror-lint-markers"]);
            self.editor.setOption("lint", true);
          }

          self.editor.on("change", function() {
            if(self.ready && self.timeout) {
              $timeout.cancel(self.timeout);
              self.timeout = null;
            }
            if (self.loaded && !self.isBinaryFile) {
              self.timeout = $timeout(function() {
                self.project.saveFile(self.question, self.folder, self.file, self.contents)
                  .catch(function (error) {
                    errors.report(error, "Could not save file!");
                  })
                  .then(function () {
                    self.timeout = null;
                  });
              }, 2000);
              self.console.errors = [];
            } else {
              self.editor.clearHistory();
              if(self.undoHistory[self.folder] &&
                self.undoHistory[self.folder][self.file]) {
                self.editor.setHistory(self.undoHistory[self.folder][self.file]);
              }
              if(self.scrollInfo[self.folder] &&
                self.scrollInfo[self.folder][self.file]) {
                var scr = self.scrollInfo[self.folder][self.file];
                self.editor.scrollTo(scr.left, scr.top);
                self.editor.setCursor(scr.line - 1, scr.col - 1);
              }
            }
            self.loaded = true;
          });
          function updateColNums() {
            $timeout(function() {
              self.col = self.editor.getCursor().ch + 1;
              self.line = self.editor.getCursor().line + 1;
            }, 0);
          }
          self.editor.on("cursorActivity", updateColNums);
          self.editor.on("focus", updateColNums);
          self.editor.on("blur", updateColNums);
          $timeout(onResize, 0);
        };
        function betterTab(){
          if(self.editor.somethingSelected()){
            self.editor.indentSelection("add");
          } else {
            self.editor.replaceSelection(Array(self.editor.getOption("indentUnit") + 1).join(" "), "end", "+input");
          }
        }
        function negTab(){
          if(self.editor.somethingSelected()){
            self.editor.indentSelection("subtract");
          }
        }
        self.refreshSettings = function () {
          // var theme = settings.settings.theme_style === "light" ? "3024-day" : "3024-night";
          var theme = settings.settings.theme_style === "light" ? "default" : "3024-night";
          self.editorOptions = {
            scrollbarStyle: "overlay",
            autofocus: true,
            lineWrapping: true,
            lineNumbers: !self.isBinaryFile,
            readOnly: !self.ready || self.isBinaryFile,
            mode: mime,
            theme: theme,
            tabSize: parseInt(settings.settings.tab_width),
            indentUnit: parseInt(settings.settings.tab_width),
            onLoad: self.editorLoad,
            matchBrackets: true,
            rulers: [80],
            extraKeys: {
              "Ctrl-Space": "autocomplete",
              "Ctrl-Enter": function() {
                self.editor.setOption('fullScreen', !self.editor.getOption('fullScreen'));
              },
              "Ctrl-I": self.indentAll,
              "Esc": function() {
                if(self.editor.getOption('fullScreen')) self.editor.setOption('fullScreen', false);
              },
              // capture save shortcuts and ignore in the editor
              "Ctrl-S": function() { },
              "Cmd-S": function() { },
              "Tab": betterTab,
              "Shift-Tab": negTab,
            }
          };
          self.consoleOptions = {
            scrollbarStyle: "overlay",
            lineWrapping: true,
            readOnly: true,
            mode: "text/plain",
            theme: theme,
            onLoad: self.consoleLoad
          };
          var main_hotkeys = [{
            combo: 'ctrl+d',
            description: 'Sends EOF',
            allowIn: ['INPUT', 'TEXTAREA'],
            callback: function(evt) {
              evt.preventDefault();
              self.sendEOF();
            }
          }, {
            combo: 'ctrl+k',
            description: "Kills the currently running program.",
            allowIn: ['INPUT', 'SELECT', 'TEXTAREA'],
            callback: function (evt) {
              evt.preventDefault();
              self.killProgram();
            }
          }];
          var vim_disabled_hotkeys = [{
            combo: 'ctrl+r',
            description: "Runs the program",
            allowIn: ['INPUT', 'SELECT', 'TEXTAREA'],
            callback: function (evt) {
              evt.preventDefault();
              self.runFile();
            }
          }, {
            combo: 'ctrl+e',
            description: "Starts Tests",
            allowIn: ['INPUT', 'SELECT', 'TEXTAREA'],
            callback: function (evt) {
              evt.preventDefault();
              self.testFile();
            }
          }];

          if(settings.settings.editor_mode !== 'vim') {
            _.each(vim_disabled_hotkeys, function(hk) {
              hotkeys.bindTo($scope.$parent).add(hk);
            });
          }
          else {
            _.each(vim_disabled_hotkeys, function(hk) {
              hotkeys.del(hk.combo);
            });
          }
          _.each(main_hotkeys, function(hk) {
            hotkeys.bindTo($scope.$parent).add(hk);
          });

          if (settings.settings.editor_mode === 'vim') {
            self.editorOptions.vimMode = true;
          } else if(settings.settings.editor_mode === 'emacs') {
            self.editorOptions.vimMode = false;
          } else {
            self.editorOptions.keyMap = 'default';
            self.editorOptions.vimMode = false;
          }

          if (self.editorOptions.vimMode) {
            delete self.editorOptions.extraKeys.Esc;
          }
          // If the CodeMirror has been loaded, add it to the editor.
          if (self.editor) {
            for (var key in self.editorOptions) {
              self.editor.setOption(key, self.editorOptions[key]);
            }
            self.editor.refresh();
          }
          if (self.consoleEditor) {
            for (var cKey in self.consoleOptions) {
              self.consoleEditor.setOption(cKey, self.consoleOptions[cKey]);
            }
            self.consoleEditor.refresh();
          }
          onResize();
        };
        self.renameFile = function() {
          renameModal(self.project, self.question, self.folder, self.file, function(newName) {
            var path = newName.split("/");
            $scope.$parent.refresh();
            $state.go("edit-project.editor.file", {
              question:(path[0]=="common"?self.question:path[0]),
              part:(path.length>2?path[1]:(path[0]=="common"?"common":"question")),
              file:escape(path.length>2?path[2]:path[1])});
          });
        };

        self.deleteFile = function() {
          confirmModal("Delete File", "Are you sure you want to delete '"+self.file+"'?")
            .then(function() {
              self.project.deleteFile(self.question, self.folder, self.file)
                .then(function() {
                  $scope.$parent.refresh();
                  $state.go("edit-project.editor");
                  self.refreshRunner();
                });
            });
        };

        function handleCompileErr(msgs, warn_only) {
          if(msgs.length === 0) return;
          else if(!warn_only)
            self.console.write("Compilation failed with errors:\n");
          else
            self.console.write("Compilation generated warnings:\n");
          self.console.errors = msgs;
          if(self.ext=="h"||self.ext=="c") {
            self.editor.setOption("lint", false);
            self.editor.setOption("lint", true);
          }
          _.each(msgs, function(res) {
            self.console.write(sprintf("%s:%d:%d: %s\n", res[1], res[2], res[3], res[4]));
          });
        }

        self.runFile = function() {runWhenSaved(function () {
          self.killProgram().then(function() {
            self.console.clear();
            self.project.run(self.question, false)
              .then(function(res) {
                $scope.$broadcast('program-running');
                self.console.setRunning(self.project, [res.pid], false);
                handleCompileErr(res.messages, true);
                self.console.write("Running '"+self.project.name+"/"+self.question+"':\n");
              })
              .catch(function(res) {
                if(res.status === "compile-failed") {
                  handleCompileErr(res.messages);
                } else {
                  errors.report(res, "An error occurred when running the project.");
                }
              });
          }).catch(function (error) {
            errors.report(error, "Could not kill program!");
          });
        });};

        self.testFile = function() {runWhenSaved(function () {
          self.killProgram().then(function() {
            self.console.clear();
            self.project.run(self.question, true)
              .then(function(res) {
                self.console.setRunning(self.project, res.pids, true);
                handleCompileErr(res.messages, true);
                self.console.write("Running tests for '"+self.project.name+"/"+self.question+"':\n");
              })
              .catch(function(res) {
                if(res.status === "compile-failed") {
                  handleCompileErr(res.messages);
                } else {
                  errors.report(res, "An error occurred when running the project.");
                }
              });
          }).catch(function (error) {
            errors.report(error, "Could not kill program!");
          });
        });};

        self.killProgram = function() {
          if(!self.console.PIDs) {
            return $q.when();
          }
          var p = $q.all(_.map(self.console.PIDs, function(id) {
            return self.project.kill(id);
          }))
          .catch(function (error) {
            errors.report(error, "Could not stop program!");
          });
          self.console.running = false;
          self.console.PIDs = null;
          return p;
        };

        self.indentAll = function() {
          self.editor.operation(function () {
            var lineCount = self.editor.lineCount();
            for (var i = 0; i < lineCount; i++) { self.editor.indentLine(i); }
          });
        };

        self.userInput = "";
        self.sendInput = function($event) {
          if($event.keyCode == 13) {
            if(self.console.running) {
              self.project.sendInput(self.console.PIDs[0], self.userInput + "\n");
              self.console.flushForInput();
              self.console.write(self.userInput + "\n");
              self.userInput = "";
            }
          }
        };

        self.clearConsole = function () {
          self.console.clear();
        };

        self.sendEOF = function() {
          if(self.console.running) {
            var d;
            if(self.userInput) {
              d = self.project.sendInput(self.console.PIDs[0], self.userInput);
            }
            else {
              d = $q.defer();
              d.resolve();
              d = d.promise;
            }
            d.then(function() {
              self.userInput = "";
              self.project.sendEOF(self.console.PIDs[0]).then(function () {
                self.console.running = false;
              });
            });
          }
        };

        self.setFileToRun = function() {
            self.project.setFileToRun(self.question, self.folder, self.file)
              .then(function () {
                  $scope.$emit('setFileToRun', []);
                  self.runnerFile = true;
                  self.isFileToRun = true;
              })
              .catch(function (error) {
                 errors.report(error, "Could not set runner file!");
              });

            // emit an event to the parent scope for
            // since EditorController is in the child scope of EditorFileController

        };

        // Initialization code goes here.
        var key = settings.addWatcher(function () {self.refreshSettings();}, true);

        $scope.$on("$destroy", function() {
          if (self.timeout && self.ready) {
            $timeout.cancel(self.timeout);
            self.project.saveFile(self.question, self.folder, self.file, self.contents);
          }
          settings.removeWatcher(key);
        });
        self.project.openFile(self.question, self.folder, self.file)
          .then(function(conts) {
            self.contents = conts;
            self.ready = true;
            if (conts.length === 0) self.loaded = true;
            self.project.updateMostRecentlyUsed(self.question, self.folder, self.file);
            self.refreshSettings();
          }).catch(function (error) {
            if (error.indexOf("bytes->string/utf-8: string is not a well-formed UTF-8 encoding") != -1) {
              self.isBinaryFile = true;
              self.refreshSettings();
            }
            else {
              errors.report(error, sprintf("Unexpected error while reading file %s!", self.file));
              $state.go('edit-project.editor');
            }
          });

        // true iff the given file has the given extension
        function has_ext(ext, fname){
          return fname.split(".").pop() === ext;
        }

        self.refreshRunner = function () {
          self.project.getFileToRun(self.question)
             .then(function (result) {
                 self.runnerFile = (result !== "");
                 self.isFileToRun = (result === self.file);
             });
        };
        self.refreshRunner();

      }]);
