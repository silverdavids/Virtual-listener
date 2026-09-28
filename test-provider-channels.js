const test=require('node:test');
const assert=require('node:assert/strict');
const {parseFeedEventsBoards,buildFeedEventsQueuePayload}=require('./auto-sync');
const {parseLiveBoard}=require('./provider-live-state');
const fixture=require('./test-fixtures/provider-progress.json');
test('captured Champions queue distinguishes channel scene from changing season number',()=>{
 const captured=require('./test-fixtures/champions-channels.json');
 const boards=parseFeedEventsBoards(captured,'21');
 const expected={'788392771':'SCENE_4','788394975':'SCENE_4','788392131':'SCENE_6','788394853':'SCENE_6'};
 for(const [id,scene]of Object.entries(expected))assert.equal(boards.find(b=>b.providerEventId===id).scenePolicy,scene);
 assert.equal(buildFeedEventsQueuePayload(boards,Date.parse(captured.capturedAt)).boards.length,captured.events.length);
});
for(const scene of ['SCENE_4','SCENE_6'])test(`${scene} survives board, queue, fixture and lifecycle normalization`,()=>{
 const raw=structuredClone(fixture.events[0]);raw.f.b.d=scene;
 const league=String(raw.f.b.a.d??raw.f.b.a.a.d);
 const [parsed]=parseFeedEventsBoards({events:[raw]},league);
 assert.equal(parsed.scenePolicy,scene);assert.ok(parsed.events.every(e=>e.scenePolicy===scene));
 assert.equal(buildFeedEventsQueuePayload([parsed],Date.now()).boards[0].scenePolicy,scene);
 assert.equal(parseLiveBoard(raw,fixture.header.serverTime,league).scenePolicy,scene);
});
