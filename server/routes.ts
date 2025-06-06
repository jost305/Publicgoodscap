import type { Express } from "express";
import { createServer, type Server } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { storage } from "./storage";
import { FundingStatusEnum, ProjectStatusEnum, CategoryEnum, insertCommentSchema, insertActivitySchema } from "@shared/schema";
import { z } from "zod";

interface ClientToServerEvents {
  "join-project": (projectId: number) => void;
  "leave-project": (projectId: number) => void;
}

interface ServerToClientEvents {
  "comment-added": (comment: any) => void;
  "comment-updated": (comment: any) => void;
  "comment-deleted": (commentId: number) => void;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Get all projects
  app.get("/api/projects", async (req, res) => {
    try {
      const category = req.query.category as string;
      const sortBy = req.query.sortBy as string;
      const searchQuery = req.query.search as string;
      
      let projects = await storage.getAllProjects();
      
      // Filter by category if specified
      if (category && category !== 'all') {
        projects = projects.filter(project => project.category === category);
      }
      
      // Filter by search query if specified
      if (searchQuery) {
        const lowercaseQuery = searchQuery.toLowerCase();
        projects = projects.filter(project => 
          project.name.toLowerCase().includes(lowercaseQuery) || 
          project.description.toLowerCase().includes(lowercaseQuery)
        );
      }
      
      // Sort the projects
      if (sortBy) {
        switch (sortBy) {
          case 'total_funding':
            projects.sort((a, b) => b.totalFunding - a.totalFunding);
            break;
          case 'recently_added':
            projects.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());
            break;
          case 'most_supported':
            projects.sort((a, b) => (b.pointsCount || 0) - (a.pointsCount || 0));
            break;
          case 'trending':
          default:
            // Sort by a combination of factors (hot, trending, funding progress)
            projects.sort((a, b) => {
              if (a.isHot && !b.isHot) return -1;
              if (!a.isHot && b.isHot) return 1;
              if (a.isTrending && !b.isTrending) return -1;
              if (!a.isTrending && b.isTrending) return 1;
              return b.totalFunding - a.totalFunding;
            });
        }
      }
      
      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  // Get project by ID
  app.get("/api/projects/:id", async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      res.json(project);
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  // WebSocket setup
  const httpServer = createServer(app);
  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Socket.IO connection handling
  io.on("connection", (socket) => {
    console.log("Client connected");

    socket.on("join-project", (projectId) => {
      socket.join(`project-${projectId}`);
    });

    socket.on("leave-project", (projectId) => {
      socket.leave(`project-${projectId}`);
    });
  });

  // Comments endpoints
  app.get("/api/projects/:projectId/comments", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      const comments = await storage.getComments(projectId);
      res.json(comments);
    } catch (error) {
      console.error("Error fetching comments:", error);
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  app.post("/api/projects/:projectId/comments", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      const userId = req.body.userId; // In real app, get from auth session
      
      const commentData = insertCommentSchema.parse({
        ...req.body,
        projectId,
        userId
      });
      
      const comment = await storage.createComment(commentData);
      
      // Notify clients in real-time
      io.to(`project-${projectId}`).emit("comment-added", comment);
      
      res.status(201).json(comment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid comment data", errors: error.errors });
      }
      console.error("Error creating comment:", error);
      res.status(500).json({ message: "Failed to create comment" });
    }
  });

  app.post("/api/comments/:id/like", async (req, res) => {
    try {
      const commentId = parseInt(req.params.id);
      const comment = await storage.upvoteComment(commentId);
      
      if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
      }
      
      // Notify clients in real-time
      io.to(`project-${comment.projectId}`).emit("comment-updated", comment);
      
      res.json(comment);
    } catch (error) {
      console.error("Error upvoting comment:", error);
      res.status(500).json({ message: "Failed to upvote comment" });
    }
  });

  app.delete("/api/comments/:id", async (req, res) => {
    try {
      const commentId = parseInt(req.params.id);
      const comment = await storage.getComment(commentId);
      
      if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
      }
      
      // TODO: Check if user has permission to delete
      
      await storage.deleteComment(commentId);
      
      // Notify clients in real-time
      io.to(`project-${comment.projectId}`).emit("comment-deleted", commentId);
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting comment:", error);
      res.status(500).json({ message: "Failed to delete comment" });
    }
  });

  // Activities endpoints
  app.get("/api/projects/:projectId/activities", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      const activities = await storage.getActivities(projectId);
      res.json(activities);
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ message: "Failed to fetch activities" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      // TODO: Add authentication
      const projectData = req.body;
      
      // Create new project
      const project = await storage.createProject(projectData);
      
      res.status(201).json(project);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid project data", errors: error.errors });
      }
      console.error("Error creating project:", error);
      res.status(500).json({ message: "Failed to create project" });
    }
  });

  app.post("/api/projects/import", async (req, res) => {
    try {
      const { platform, projectUrl } = req.body;
      
      // TODO: Implement external platform data fetching
      throw new Error("Not implemented");
      
      // The following would be the implementation:
      // const projectData = await fetchExternalProjectData(platform, projectUrl);
      // const project = await storage.createProject(projectData);
      // res.status(201).json(project);
    } catch (error) {
      console.error("Error importing project:", error);
      res.status(500).json({ message: "Failed to import project" });
    }
  });

  // Create project endpoint and other CRUD operations would go here
  // but aren't included in the current feature set

  return httpServer;
}
