# Kanban Board UI

The frontend for the Kanban Board MCP, built with React, Vite, and Tailwind CSS. It features a polished, "Bento Grid" inspired aesthetic and provides a drag-and-drop interface for managing tickets.

## Prerequisites
- **Node.js**: (LTS version recommended)
- **npm**: (Included with Node.js)

## Commands

### Development
```bash
npm install
npm run dev        # Starts dev server on http://localhost:5173
```

### Production
```bash
npm run build      # Builds the application for production
```

## Component Structure
The UI follows a hierarchical structure:
- `App`: Main entry point.
- `Board`: Manages the overall board state.
- `Column`: Represents a Kanban stage (e.g., Todo, Doing, Done).
- `TicketCard`: Individual task card with drag-and-drop support.
- `TicketModal`: Detailed view for a ticket, including a **Comments Section** and **Subtasks**.

## Design System
The UI uses a custom "Bento Grid" layout with a specific color palette:
- **Background**: `#F5EFE0` (Cream)
- **Primary**: `#3D0C11` (Deep Burgundy)
- **Accents**: 
  - Yellow: `#F5C518`
  - Pink: `#F472B6`
  - Lime: `#AACC2E`
  - Orange: `#E8441A`
  - Blue: `#5BB8F5`

