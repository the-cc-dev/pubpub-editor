import { Plugin } from 'prosemirror-state';
import { Slice } from 'prosemirror-model';
import firebase from 'firebase';
import { insertPoint } from 'prosemirror-transform';
import { keys } from './pluginKeys';
import { schema } from '../schema';

const { Selection } = require('prosemirror-state')
const { Node } = require('prosemirror-model')
const { Step } = require('prosemirror-transform')
const { collab, sendableSteps, receiveTransaction } = require('prosemirror-collab')
const { compressStepsLossy, compressStateJSON, uncompressStateJSON, compressSelectionJSON, uncompressSelectionJSON, compressStepJSON, uncompressStepJSON } = require('prosemirror-compress')
const TIMESTAMP = { '.sv': 'timestamp' }


const { DecorationSet, Decoration } = require('prosemirror-view');


const firebaseConfig = {
  apiKey: "AIzaSyBpE1sz_-JqtcIm2P4bw4aoMEzwGITfk0U",
  authDomain: "pubpub-rich.firebaseapp.com",
  databaseURL: "https://pubpub-rich.firebaseio.com",
  projectId: "pubpub-rich",
  storageBucket: "pubpub-rich.appspot.com",
  messagingSenderId: "543714905893"
};
const firebaseApp = firebase.initializeApp(firebaseConfig);
const db = firebase.database(firebaseApp);

function stringToColor(string, alpha = 1) {
    let hue = string.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360
    return `hsla(${hue}, 100%, 50%, ${alpha})`
}



const FirebasePlugin = ({ selfClientID }) => {

  console.log('creating firebase plugin!!', selfClientID);

  const collabEditing = require('prosemirror-collab').collab;
  const firebaseRef = firebase.database().ref("testEditor");

  const checkpointRef  = firebaseRef.child('checkpoint');
  const changesRef = firebaseRef.child('changes');
  const selectionsRef = firebaseRef.child('selections');
  const selfSelectionRef = selectionsRef.child(selfClientID);
  selfSelectionRef.onDisconnect().remove();
  const selections = {};
  const selfChanges = {};
  let selection = undefined;
  let fetchedState = false;
  let latestKey;

  const loadDocumentAndListen = (view) => {

    console.log('loading document!');
    console.log(view);
    if (fetchedState) {
      return;
    }

    checkpointRef.once('value').then(
      function (snapshot) {
        // progress(1 / 2)
        let { d, k } = snapshot.val() || {}
        latestKey = k ? k : -1;
        latestKey = Number(latestKey)
        const newDoc = d && Node.fromJSON(view.state.schema, uncompressStateJSON({ d }).doc)

        function compressedStepJSONToStep(compressedStepJSON) {
          return Step.fromJSON(view.state.schema, uncompressStepJSON(compressedStepJSON)) }

        fetchedState = true;

        const { EditorState } = require('prosemirror-state');
    		const newState = EditorState.create({
    			doc: newDoc,
    			plugins: view.state.plugins,
    		});
    		view.updateState(newState);

        return changesRef.startAt(null, String(latestKey + 1)).once('value').then(
          function (snapshot) {
            // progress(2 / 2)
            // const view = this_.view = constructView({ newDoc, updateCollab, selections })
            const editor = view
            console.log('got editor change!', view);

            const changes = snapshot.val()
            if (changes) {
              const steps = []
              const stepClientIDs = []
              const placeholderClientId = '_oldClient' + Math.random()
              const keys = Object.keys(changes)
              latestKey = Math.max(...keys)
              for (let key of keys) {
                const compressedStepsJSON = changes[key].s
                steps.push(...compressedStepsJSON.map(compressedStepJSONToStep))
                stepClientIDs.push(...new Array(compressedStepsJSON.length).fill(placeholderClientId))
              }
              editor.dispatch(receiveTransaction(editor.state, steps, stepClientIDs))
            }

            function updateClientSelection(snapshot) {
              const clientID = snapshot.key
              if (clientID !== selfClientID) {
                const compressedSelection = snapshot.val()
                if (compressedSelection) {
                  try {
                    selections[clientID] = Selection.fromJSON(editor.state.doc, uncompressSelectionJSON(compressedSelection))
                  } catch (error) {
                    console.warn('updateClientSelection', error)
                  }
                } else {
                  delete selections[clientID]
                }
                editor.dispatch(editor.state.tr)
              }
            }
            selectionsRef.on('child_added', updateClientSelection)
            selectionsRef.on('child_changed', updateClientSelection)
            selectionsRef.on('child_removed', updateClientSelection)

            changesRef.startAt(null, String(latestKey + 1)).on(
              'child_added',
              function (snapshot) {
                latestKey = Number(snapshot.key)
                const { s: compressedStepsJSON, c: clientID } = snapshot.val()
                const steps = (
                  clientID === selfClientID ?
                    selfChanges[latestKey]
                  :
                    compressedStepsJSON.map(compressedStepJSONToStep) )
                const stepClientIDs = new Array(steps.length).fill(clientID)
                editor.dispatch(receiveTransaction(editor.state, steps, stepClientIDs))
                delete selfChanges[latestKey]
              } )

            /*
            return Object.assign({
              destroy: this_.destroy.bind(this_),
            }, this_);
            */

          } )
      } );

  }



  return new Plugin({
  	state: {
  		init(config, instance) {
        console.log('init plugin!')
  			return { };
  		},
  		apply(transaction, state, prevEditorState, editorState) {
  			return { };
  		}
  	},

    view: function(editorView) {
      console.log('init view!');
  		this.editorView = editorView;
  		loadDocumentAndListen(editorView);
  		return {
  			update: (newView, prevState) => {
  				this.editorView = newView;
  			},
  			destroy: () => {
  				this.editorView = null;
  			}
  		}
  	},

  	props: {

      updateCollab({ docChanged, mapping }, newState) {
        if (docChanged) {
          for (let clientID in selections) {
            selections[clientID] = selections[clientID].map(newState.doc, mapping)
          }
        }
        const sendable = sendableSteps(newState)
        if (sendable) {
          const { steps, clientID } = sendable
          changesRef.child(latestKey + 1).transaction(
            function (existingBatchedSteps) {
              if (!existingBatchedSteps) {
                selfChanges[latestKey + 1] = steps
                return {
                  s: compressStepsLossy(steps).map(
                    function (step) {
                      return compressStepJSON(step.toJSON()) } ),
                  c: clientID,
                  t: TIMESTAMP,
                }
              }
            },
            function (error, committed, { key }) {
              if (error) {
                console.error('updateCollab', error, sendable, key)
              } else if (committed && key % 100 === 0 && key > 0) {
                const { d } = compressStateJSON(newState.toJSON())
                checkpointRef.set({ d, k: key, t: TIMESTAMP })
              }
            },
            false )
        }

        const selectionChanged = !newState.selection.eq(selection)
        if (selectionChanged) {
          selection = newState.selection
          selfSelectionRef.set(compressSelectionJSON(selection.toJSON()))
        }
      },


  		decorations(state) {
        return DecorationSet.create(state.doc, Object.entries(selections).map(
          function ([ clientID, { from, to } ]) {
              if (from === to) {
                  let elem = document.createElement('span')
                  elem.style.borderLeft = `1px solid ${stringToColor(clientID)}`
                  return Decoration.widget(from, elem)
              } else {
                  return Decoration.inline(from, to, {
                      style: `background-color: ${stringToColor(clientID, 0.2)};`,
                  })
              }
          }
        ));
  		},
  	},
    key: keys.firebase,
  });

}



export default FirebasePlugin;
