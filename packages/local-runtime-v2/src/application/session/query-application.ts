import type {
  SessionLookupInput as GetSessionReq,
  SessionLookupResult as GetSessionResp,
  SessionTreeInput as GetSessionTreeReq,
  SessionTreePage as GetSessionTreeResp,
  ListSessionsInput as ListSessionsReq,
  SessionPage as ListSessionsResp,
  SearchSessionsInput as SearchSessionsReq,
  SessionPage as SearchSessionsResp,
} from "./query-contract.js";

import {
  SessionQueryServiceError,
  type SessionQueryService,
} from "../../service/session-system/index.js";
import type { ApplicationContext } from "../context.js";
import { AppError } from "../errors.js";
import {
  toProjectDetail,
  toSessionInfoView,
  toSessionTreeChildView,
  toSessionTreeNodeView,
} from "./wire.js";
import type { ListProjectsResp } from "./view-contract.js";
import type { ProjectListInput } from "../../service/session-system/projects/contracts.js";
import type { ProjectService } from "../../service/session-system/projects/service.js";

export interface SessionQueryApplicationOptions {
  readonly service: Pick<
    SessionQueryService,
    "list" | "search" | "tree" | "get"
  >;
  readonly projects?: Pick<ProjectService, "list" | "listSessions">;
}

/** Local Session query; parameters come from the service contract and results are built by local view converters. */
export class SessionQueryApplication {
  constructor(private readonly options: SessionQueryApplicationOptions) {}

  /**
   * The projects, each carrying the sessions that belong to it.
   *
   * `listVisibleProjects` answers "which projects exist" and therefore drops
   * the sessions on the floor. A client that renders a project's conversations
   * needs both halves in one read, so this is the group form of the same
   * query: the project view plus its session tree, in the Desktop's shape.
   */
  async listProjectGroups(input: ProjectListInput): Promise<ListProjectsResp> {
    if (!this.options.projects) throw new Error("Project listing is unavailable.");
    const page = await this.options.projects.list(input);
    return {
      projects: page.projects.map((group) => ({
        project: toProjectDetail(group.project),
        sessions: group.sessions.map((session) =>
          toSessionTreeNodeView(session, group.childrenByParent),
        ),
        hasMoreSessions: group.hasMoreSessions,
        ...(group.nextSessionCursor
          ? { nextSessionCursor: group.nextSessionCursor }
          : {}),
      })),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async listProjectSessions(
    reference: Parameters<ProjectService["listSessions"]>[0],
    input: Parameters<ProjectService["listSessions"]>[1],
  ) {
    if (!this.options.projects) throw new Error("Project listing is unavailable.");
    const page = await this.options.projects.listSessions(reference, input);
    return {
      sessions: page.sessions.map((session) => toSessionTreeNodeView(session, page.childrenByParent)),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  listVisibleProjects(limit = 100) {
    if (!this.options.projects) throw new Error("Project listing is unavailable.");
    return this.options.projects
      .list({
        // The sidebar shows projects across Agents. The session rail still
        // filters conversations to the primary Agent further down the stack.
        sessionFilter: {
          archived: false,
          includeHidden: false,
          excludeInternalTreeSessions: true,
        },
        limit,
        sessionLimit: 1,
      })
      .then((page) => page.projects.map(({ project }) => project));
  }

  async listSessions(
    _context: ApplicationContext,
    req: ListSessionsReq,
  ): Promise<ListSessionsResp> {
    const page = await this.invoke(() =>
      this.options.service.list({
        agentName: req.name,
        includeArchived: req.includeArchived,
        onlyArchived: req.onlyArchived,
        onlyCompressed: req.onlyCompressed,
        includeHidden: req.includeHidden,
        includePurposePrefix: req.includePurposePrefix,
        excludePurposePrefix: req.excludePurposePrefix,
        limit: req.limit,
        offset: req.offset,
        cursor: req.cursor,
      }),
    );
    return {
      sessions: page.sessions.map(toSessionInfoView),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async searchSessions(
    _context: ApplicationContext,
    req: SearchSessionsReq,
  ): Promise<SearchSessionsResp> {
    const page = await this.invoke(() =>
      this.options.service.search({
        keyword: req.keyword,
        agentName: req.agentName,
        limit: req.limit,
        cursor: req.cursor,
      }),
    );
    return {
      sessions: page.sessions.map(toSessionInfoView),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async getSessionTree(
    _context: ApplicationContext,
    req: GetSessionTreeReq,
  ): Promise<GetSessionTreeResp> {
    const page = await this.invoke(() =>
      this.options.service.tree({
        agentName: req.name,
        includeArchived: req.includeArchived,
        onlyArchived: req.onlyArchived,
        onlyCompressed: req.onlyCompressed,
        includeHidden: req.includeHidden,
        includePurposePrefix: req.includePurposePrefix,
        excludePurposePrefix: req.excludePurposePrefix,
        limit: req.limit,
        cursor: req.cursor,
      }),
    );
    return {
      sessions: page.sessions.map(({ session, children }) => ({
        session: toSessionInfoView(session),
        childSessions: children.map(toSessionTreeChildView),
      })),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async getSession(
    _context: ApplicationContext,
    req: GetSessionReq,
  ): Promise<GetSessionResp> {
    const session = await this.invoke(() => this.options.service.get(req.id));
    return { session: toSessionInfoView(session) };
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SessionQueryServiceError) {
        const mapping = queryFailureMapping(error.reason);
        throw new AppError(mapping.status, mapping.key, error.message);
      }
      throw error;
    }
  }
}

function queryFailureMapping(reason: SessionQueryServiceError["reason"]): {
  readonly status: number;
  readonly key: string;
} {
  switch (reason) {
    case "session-not-found":
      return { status: 404, key: "SESSION_NOT_FOUND" };
  }
}
