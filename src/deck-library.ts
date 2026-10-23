import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { initialDeck, parseDeck, renderDeck, type Deck } from '../imslide.ts';
import { modeSchema, WorkspaceError, type WorkspaceAction, type WorkspaceState } from './workspace-contract.ts';
const catalogSchema = z.object({
  mode: modeSchema, activeDeckId: z.string().nullable(), workspaceRevision: z.number().int().nonnegative(),
  decks: z.array(z.object({id:z.string(),title:z.string(),file:z.string(),pageCount:z.number(),current:z.number().int().nonnegative(),updatedAt:z.string(),deletedAt:z.string().optional()})),
});
type Catalog = z.infer<typeof catalogSchema>;
export function renderEntry(file: string) { return resolve(dirname(file), `.${basename(file, '.md')}.active.md`); }
async function atomic(file: string, contents: string) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents); await rename(temporary, file);
}
/** Called exclusively inside ImSlide's shared write queue. Markdown is authoritative. */
export class DeckLibrary {
  private constructor(readonly catalogFile: string, readonly entry: string, private catalog: Catalog) {}
  static async open(file: string, first: Deck, directory = resolve(dirname(file), '.imslide')) {
    const catalogFile = resolve(directory, 'library.json');
    let catalog: Catalog;
    try { catalog = catalogSchema.parse(JSON.parse(await readFile(catalogFile, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const id = randomUUID();
      let backing=file;
      if(!(await readFile(file,'utf8')).includes('imslideId:')) {
        backing=resolve(directory,'decks',`${id}.md`);await atomic(backing,renderDeck(first));
      }
      catalog = {mode:'management',activeDeckId:id,workspaceRevision:0,decks:[{id,title:basename(file,'.md'),file:backing,current:first.current,pageCount:first.pages.length,updatedAt:new Date().toISOString()}]};
      await atomic(catalogFile, JSON.stringify(catalog));
    }
    const library = new DeckLibrary(catalogFile, renderEntry(file), catalog);
    const deck = await library.loadActive();
    await library.project(deck);
    return { library, deck };
  }
  snapshot(): WorkspaceState {
    return { ...this.catalog, decks: this.catalog.decks.map(({file:_,current:__,...summary})=>({...summary})) };
  }
  get activeFile() { return this.catalog.decks.find(d=>d.id===this.catalog.activeDeckId && !d.deletedAt)?.file; }
  async loadActive() {
    const item=this.catalog.decks.find(d=>d.id===this.catalog.activeDeckId && !d.deletedAt);
    if (!item) return initialDeck();
    const deck=parseDeck(await readFile(item.file,'utf8'));
    deck.current=Math.min(item.current,deck.pages.length-1);return deck;
  }
  private async commit(next: Catalog) {
    next.workspaceRevision++;
    await atomic(this.catalogFile,JSON.stringify(next));this.catalog=next;
  }
  async project(deck: Deck) {
    const state=this.snapshot();
    const markdown=renderDeck(deck).replace(/imslide: .*\n/,`imslide: ${JSON.stringify({current:deck.current,revision:deck.revision,deckId:state.activeDeckId})}\n`);
    await atomic(this.entry,markdown);
  }
  async saved(deck: Deck, contentChanged: boolean) {
    const next=structuredClone(this.catalog),item=next.decks.find(d=>d.id===next.activeDeckId && !d.deletedAt);
    if (!item) throw new WorkspaceError('NO_ACTIVE_DECK','没有活动文稿');
    item.current=deck.current;item.pageCount=deck.pages.length;
    if(contentChanged)item.updatedAt=new Date().toISOString();
    await this.commit(next);
    if(contentChanged)await this.project(deck);
  }
  async action(action: WorkspaceAction): Promise<{deck?:Deck; deckId?:string; decks?:WorkspaceState['decks']}> {
    if(action.tool==='get_workspace')return {};
    if(action.tool==='list_decks')return {decks:this.snapshot().decks.filter(d=>!!d.deletedAt===action.deleted && (!action.query || d.title.toLocaleLowerCase().includes(action.query.toLocaleLowerCase())))};
    const next=structuredClone(this.catalog);
    let deck:Deck|undefined,deckId:string|undefined;
    if(action.tool==='switch_mode') {
      if(action.mode!=='management' && !next.activeDeckId)throw new WorkspaceError('NO_ACTIVE_DECK','请先在管理页打开文稿');
      if(next.mode===action.mode)return {};
      next.mode=action.mode;
    } else if(action.tool==='create_deck' || action.tool==='duplicate_deck') {
      let content=initialDeck();
      let name=action.title;
      if(action.tool==='duplicate_deck') {
        const source=next.decks.find(d=>d.id===action.deckId && !d.deletedAt);
        if(!source)throw new WorkspaceError('DECK_NOT_FOUND','文稿不存在');
        content=parseDeck(await readFile(source.file,'utf8'));content.pages.forEach(p=>p.id=randomUUID());content.revision=0;content.current=0;
        name ||= `${source.title} 副本`;
      }
      deckId=randomUUID();const file=resolve(dirname(this.catalogFile),'decks',`${deckId}.md`);
      await atomic(file,renderDeck(content));
      next.decks.push({id:deckId,title:name!,file,current:0,pageCount:content.pages.length,updatedAt:new Date().toISOString()});
    } else {
      const item=next.decks.find(d=>d.id===action.deckId);
      if(!item || (action.tool!=='restore_deck' && item.deletedAt))throw new WorkspaceError('DECK_NOT_FOUND','文稿不存在，请用 list_decks 查询有效ID');
      deckId=item.id;
      if(action.tool==='open_deck') {
        deck=parseDeck(await readFile(item.file,'utf8'));deck.current=Math.min(item.current,deck.pages.length-1);
        next.activeDeckId=item.id;next.mode='preview';
      } else if(action.tool==='rename_deck') {item.title=action.title;item.updatedAt=new Date().toISOString();}
      else if(action.tool==='delete_deck') {item.deletedAt=new Date().toISOString();if(next.activeDeckId===item.id){next.activeDeckId=null;deck=initialDeck();}}
      else if(action.tool==='restore_deck')delete item.deletedAt;
    }
    await this.commit(next);
    if(deck)await this.project(deck);
    return {deck,deckId};
  }
}
