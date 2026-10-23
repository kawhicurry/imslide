/** Typed integration boundary for pinned Slidev 52.20.1. Its published client
 * contains raw TS/Vue source and expects its monorepo-only ambient declarations. */
import type { App, Component, Ref, ComputedRef } from 'vue';
import type { SlidevConfig, SlideRoute, SlideInfo, ClicksContext } from '@slidev/types';
export type NativeSlideRoute = Omit<SlideRoute, 'meta'> & { meta: SlideRoute['meta'] & {slide: SlideInfo} };
export const configs: SlidevConfig & {imslide?:{revision:number}};
export function disableBuiltinSync(): void;
export function useNav(): {slides:Ref<NativeSlideRoute[]>;go:(page:number,clicks?:number)=>Promise<void>};
export const slideWidth: ComputedRef<number>;
export const slideHeight: ComputedRef<number>;
export function createFixedClicks(route?:SlideRoute,current?:number):ClicksContext;
export default function setup():void;
export default function setup(app:App):Promise<void>;

export const themeVars: ComputedRef<Record<string,string>>;
