// Fixture stand-ins for the real service surface. `getById` is present and deliberately unguarded;
// `EventHistory.create` is the same-named method on a different declaration.
//
// `create` calls `this.createResolved` so the book.service.ts exemption has something real to
// exempt. The RuleTester case for that path feeds this file's own source back in verbatim: project
// mode keeps ONE program across cases, so a case that redeclared this class with fewer methods
// would erase them for every later case (findDuplicate silently stopped resolving that way).
export interface BookRow { id: number; title: string }

export class BookService {
  async findDuplicate(candidate: { title: string }): Promise<BookRow | null> {
    return candidate.title ? null : null;
  }
  async create(input: { title: string }): Promise<number> {
    return this.createResolved(input);
  }
  async createResolved(input: { title: string }): Promise<number> {
    return input.title.length;
  }
  async getById(id: number): Promise<BookRow | null> {
    return id > 0 ? null : null;
  }
}

export class EventHistory {
  async create(input: { kind: string }): Promise<number> {
    return input.kind.length;
  }
}

export interface CrudService<T> {
  create(data: T): Promise<number>;
}
